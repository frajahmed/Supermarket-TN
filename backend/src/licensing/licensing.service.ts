import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { loadPublicKey } from '../../../shared/license-core.ts';
import { LicenseGate, syncLicense } from '../core/license-gate.ts';
import { DbService } from '../db/db.service';

/**
 * Hält die Lizenz-Schranke und gleicht stündlich mit dem Lizenzserver ab.
 * Konfiguration (bei der Installation gesetzt):
 *   LICENSE_SERVER_URL       z. B. https://lizenz.supermarket-tn.com
 *   LICENSE_PUBLIC_KEY_FILE  öffentlicher Schlüssel des Lizenzservers (PEM)
 *   INSTALLATION_SECRET      einmalig im Lizenzportal angezeigt
 * Die Installations-ID steht in der Datenbank (auth.setup_installation).
 */
@Injectable()
export class LicensingService implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger(LicensingService.name);
  private timer?: NodeJS.Timeout;
  gate!: LicenseGate;
  installationId = '';
  tenantId = '';
  readonly licensePublicKey = loadPublicKey(readFileSync(process.env.LICENSE_PUBLIC_KEY_FILE ?? 'keys/license.pub', 'utf8'));

  constructor(private readonly db: DbService) {}

  async onModuleInit() {
    const info = await this.db.system(async (c) => (await c.query('SELECT * FROM auth.installation_info()')).rows[0]);
    if (!info) throw new Error('Installation nicht eingerichtet – auth.setup_installation() ausführen');
    this.installationId = info.installation_id;
    this.tenantId = info.tenant_id;

    this.gate = new LicenseGate(this.licensePublicKey, this.installationId, {
      load: async () => info.license_token ?? null,
      save: async (token) => { await this.db.system((c) => c.query('SELECT auth.save_license($1)', [token])); },
    });
    await this.gate.init();
    await this.sync();
    this.timer = setInterval(() => void this.sync(), Number(process.env.LICENSE_SYNC_MS ?? 3_600_000));
  }

  async sync() {
    const r = await syncLicense(this.gate, {
      serverUrl: process.env.LICENSE_SERVER_URL ?? '',
      installationId: this.installationId,
      installationSecret: process.env.INSTALLATION_SECRET ?? '',
    });
    const s = this.gate.status();
    if (r.ok) this.log.log(`Lizenz bestätigt: ${s.mode}`);
    else this.log.warn(`Lizenzabgleich fehlgeschlagen (${r.error}) – Status bleibt ${s.mode}: ${s.reason}`);
    return s;
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }
}
