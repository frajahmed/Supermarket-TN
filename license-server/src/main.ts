/**
 * Start des Lizenzservers.
 *
 *   node src/main.ts                         (Node >= 22.18, führt TypeScript direkt aus)
 *   node src/main.ts create-admin <email>    (Passwort wird über STDIN abgefragt)
 *
 * Umgebungsvariablen:
 *   LICENSE_DB         Pfad zur SQLite-Datei      (Standard: ./data/license.db)
 *   LICENSE_KEY_DIR    Ordner für das Schlüsselpaar (Standard: ./data/keys)
 *   PORT / HOST        (Standard: 8443 / 127.0.0.1 – davor Caddy/Nginx mit TLS)
 *   TRUST_PROXY=1      X-Forwarded-For auswerten (nur hinter eigenem Reverse-Proxy)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { generateSigningKeys, loadPrivateKey } from '../../shared/license-core.ts';
import { openDatabase } from './db.ts';
import { createLicenseServer } from './http.ts';
import { LicenseService } from './service.ts';

const dbPath = process.env.LICENSE_DB ?? './data/license.db';
const keyDir = process.env.LICENSE_KEY_DIR ?? './data/keys';
mkdirSync(keyDir, { recursive: true });
mkdirSync(join(dbPath, '..'), { recursive: true });

// Schlüsselpaar beim ersten Start erzeugen. Der private Schlüssel ist das wertvollste
// Geheimnis des ganzen Systems: sichern (offline) und niemals ins Repo legen.
const privPath = join(keyDir, 'license-signing.key');
const pubPath = join(keyDir, 'license-signing.pub');
if (!existsSync(privPath)) {
  const { privatePem, publicPem } = generateSigningKeys();
  writeFileSync(privPath, privatePem, { mode: 0o600 });
  writeFileSync(pubPath, publicPem);
  chmodSync(privPath, 0o600);
  console.log(`Neues Signatur-Schlüsselpaar erzeugt in ${keyDir} – jetzt sichern!`);
}
const publicPem = readFileSync(pubPath, 'utf8');
const svc = new LicenseService(openDatabase(dbPath), loadPrivateKey(readFileSync(privPath, 'utf8')));

if (process.argv[2] === 'create-admin') {
  const email = process.argv[3];
  if (!email) throw new Error('Aufruf: node src/main.ts create-admin <email>');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const password = await rl.question('Passwort (min. 12 Zeichen): ');
  rl.close();
  await svc.createAdmin(email, password);
  console.log(`Admin ${email} angelegt.`);
  process.exit(0);
}

const port = Number(process.env.PORT ?? 8443);
const host = process.env.HOST ?? '127.0.0.1';
createLicenseServer(svc, publicPem, { trustProxy: process.env.TRUST_PROXY === '1' })
  .listen(port, host, () => console.log(`Lizenzserver läuft auf http://${host}:${port} (Portal: /admin)`));
