/**
 * Lizenz-Schranke des Kundenservers.
 *
 * Hält die zuletzt vom Lizenzserver erhaltene, signierte Lizenzbestätigung und
 * entscheidet daraus:
 *   - ob überhaupt angemeldet werden darf (unlicensed = nie bestätigt -> nein),
 *   - ob geschrieben werden darf (read_only nach Mietende oder >14 Tage ohne Abgleich),
 *   - welche Geräte gesperrt sind.
 * Der Laden läuft bei Internetausfall weiter, bis graceUntil der letzten Bestätigung erreicht ist.
 */
import type { KeyObject } from 'node:crypto';
import { verifyToken, TokenError, type LicenseToken } from '../../../shared/license-core.ts';

export type EffectiveMode = 'active' | 'warning' | 'read_only' | 'unlicensed';

export interface LicenseStatus {
  mode: EffectiveMode;
  reason: string;
  customer?: string;
  paidUntil?: string;
  lastConfirmedAt?: number;
  offlineUntil?: number;
}

export interface LicenseStore {
  load(): Promise<string | null>;
  save(token: string): Promise<void>;
}

export class LicenseGate {
  private current: LicenseToken | null = null;
  private revoked = new Set<string>();
  private readonly publicKey: KeyObject;
  private readonly installationId: string;
  private readonly store: LicenseStore;
  private readonly clock: () => number;

  constructor(publicKey: KeyObject, installationId: string, store: LicenseStore,
    clock: () => number = () => Math.floor(Date.now() / 1000)) {
    this.publicKey = publicKey;
    this.installationId = installationId;
    this.store = store;
    this.clock = clock;
  }

  /** Beim Start: gespeicherte Bestätigung laden (gilt weiter, auch ohne Internet). */
  async init(): Promise<void> {
    const saved = await this.store.load();
    if (saved) {
      try {
        this.apply(saved);
      } catch {
        /* beschädigt/manipuliert -> ignorieren, nächster Abgleich ersetzt sie */
      }
    }
  }

  /** Neue Bestätigung vom Lizenzserver übernehmen (nach Signatur- und Plausibilitätsprüfung). */
  async accept(token: string): Promise<LicenseToken> {
    const lic = this.apply(token);
    await this.store.save(token);
    return lic;
  }

  private apply(token: string): LicenseToken {
    const lic = verifyToken<LicenseToken>(token, this.publicKey, 'license');
    if (lic.inst !== this.installationId) throw new TokenError('Lizenz gehört zu einer anderen Installation');
    if (this.current && lic.iat < this.current.iat) throw new TokenError('Ältere Lizenz als die vorhandene');
    if (lic.iat > this.clock() + 300) throw new TokenError('Lizenz aus der Zukunft – Uhrzeit des Servers prüfen');
    this.current = lic;
    this.revoked = new Set(lic.revokedDevices);
    return lic;
  }

  status(): LicenseStatus {
    const lic = this.current;
    if (!lic) return { mode: 'unlicensed', reason: 'Noch keine Lizenzbestätigung – Internetverbindung zum Lizenzserver herstellen' };
    const base = { customer: lic.customer, paidUntil: lic.paidUntil, lastConfirmedAt: lic.iat, offlineUntil: lic.graceUntil };
    if (this.clock() > lic.graceUntil) {
      return { ...base, mode: 'read_only', reason: 'Lizenz seit über 14 Tagen nicht bestätigt – Internetverbindung prüfen' };
    }
    if (lic.mode === 'read_only') return { ...base, mode: 'read_only', reason: 'Miete abgelaufen oder Lizenz gesperrt – nur Lesen möglich' };
    if (lic.mode === 'warning') return { ...base, mode: 'warning', reason: `Miete am ${lic.paidUntil} abgelaufen – bitte verlängern` };
    return { ...base, mode: 'active', reason: 'Lizenz gültig' };
  }

  isDeviceRevoked(deviceId: string): boolean {
    return this.revoked.has(deviceId);
  }

  /** Schreibende Anfragen nur bei aktiver Lizenz oder in der Warnphase. */
  allowsWrite(): boolean {
    const m = this.status().mode;
    return m === 'active' || m === 'warning';
  }
}

/**
 * Abgleich mit dem Lizenzserver. Fehler (kein Internet) sind normal und werden nur gemeldet:
 * die gespeicherte Bestätigung gilt bis graceUntil weiter.
 */
export async function syncLicense(gate: LicenseGate, opts: {
  serverUrl: string; installationId: string; installationSecret: string;
  fetchImpl?: typeof fetch; timeoutMs?: number;
}): Promise<{ ok: true; mode: string } | { ok: false; error: string }> {
  const f = opts.fetchImpl ?? fetch;
  try {
    const res = await f(`${opts.serverUrl}/v1/license/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.installationSecret}` },
      body: JSON.stringify({ installationId: opts.installationId }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    if (!res.ok) return { ok: false, error: `Lizenzserver antwortet ${res.status}` };
    const { license } = await res.json() as { license: string };
    const lic = await gate.accept(license);
    return { ok: true, mode: lic.mode };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
