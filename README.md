# Supermarket-TN – Warenwirtschaft, Großhandel & Kasse

Supermarkt- und Großhandelssoftware, erster Markt Tunesien (Arabisch, Französisch, Englisch, TND).
Betrieb: ein lokaler Server pro Kunde, Zugriff im Laden über WLAN/LAN, von unterwegs über Tunnel.

## Zusammenarbeit

- **Codex** entwickelt nach [`AGENTS.md`](AGENTS.md) und nimmt Aufgaben aus [`docs/TASKS.md`](docs/TASKS.md).
- **Claude** pflegt die Aufgaben, prüft jede Lieferung mit `bash scripts/test-all.sh` und gibt frei.

## Inhalt

| Pfad | Inhalt | Status |
| --- | --- | --- |
| `db/001_schema.sql` | Vollständiges Schema: Mandanten, Filialen, 4 Rollen + Rechtekatalog, Produkte (mehrsprachig, Allergene, Nährwerte, MHD-Chargen), Bestandsjournal mit Trigger, Einkauf, Belege (TEIF/QR/OCR), Kasse mit Fiskal-Feldern, Outbox, Audit, RLS-Policies, Dashboard-Views | getestet gegen PostgreSQL 16 |
| `db/002_outbox_claim.sql` | Abholung der Echtzeit-Events für den Worker | getestet |
| `db/003_wholesale.sql` | Großhandel: Geschäftskunden (Matricule fiscal), Kundengruppen, Preislisten mit Staffeln, Gebinde, Aufträge, Ausgangsrechnungen (lückenlos nummeriert, unveränderlich, TVA je Satz, Timbre, TTN-Status), Zahlungen, Kreditlimit | getestet |
| `db/tests/001_rls_test.sql` | 12 Prüfungen (T1–T11): Isolation, Filialrechte, Kassierer-Sperre, Idempotenz, unveränderliches Journal, Login-Lookup, Outbox | alle bestanden |
| `db/tests/003_wholesale_test.sql` | 8 Prüfungen (W0–W7): Preisstaffeln, Rechnungssummen, Nummernkreis ohne Lücken, Unveränderlichkeit, Kreditlimit, Kassierer, Mandantentrennung | alle bestanden |
| `db/004_auth_devices.sql` | Anmeldung: Installation (ein Kunde je Server), Geräteregistrierung, Sperre nach Fehlversuchen (15 min, verdoppelnd), Refresh-Token-Rotation mit Diebstahlerkennung, lokales Gerätesperren | getestet |
| `db/tests/004_auth_test.sql` | 7 Prüfungen (A1–A6) | alle bestanden |
| `shared/license-core.ts` | Gemeinsamer Kern: signierte Gerätezertifikate und Lizenzbestätigungen (Ed25519), Besitznachweis per Challenge, Passwort-/PIN-Hashing (scrypt) | getestet |
| `license-server/` | Zentraler Lizenzserver (nur Node, keine Pakete, SQLite): Mietverträge, Geräte-Freischaltung, stündlicher Lizenzabgleich, Verwaltungsportal unter `/admin` | 10 Tests bestanden, im Browser geprüft |
| `backend/src/core/` | Framework-freier Kern des Kundenservers: Lizenz-Schranke (14 Tage offline, Nur-Lesen nach Mietende), Login-Ablauf (Gerät + Passwort/PIN), eigenes JWT | 16 Gesamttests mit echtem Lizenzserver bestanden |
| `backend/` | NestJS-Kern: DB-Zugang mit RLS-Kontext, JWT-Guard (EdDSA), Rechteprüfung, Offline-Sync Push/Pull, Bestandswarnungen, WebSocket-Gateway, Outbox-Worker, Geldlogik (TND = 3 Stellen) | Geldlogik und alle SQL-Abfragen geprüft; Kompilieren + Integrationstest noch lokal auszuführen (siehe unten) |

## Datenbank aufsetzen

```bash
createdb warenwirtschaft
psql -d warenwirtschaft -v ON_ERROR_STOP=1 -f db/001_schema.sql -f db/002_outbox_claim.sql -f db/003_wholesale.sql -f db/004_auth_devices.sql
psql -d warenwirtschaft -c "ALTER ROLE app_user LOGIN PASSWORD 'bitte-ändern'"

# Tests (laufen in einer Transaktion, hinterlassen nichts)
psql -d warenwirtschaft -v ON_ERROR_STOP=1 -f db/tests/001_rls_test.sql
psql -d warenwirtschaft -v ON_ERROR_STOP=1 -f db/tests/003_wholesale_test.sql
psql -d warenwirtschaft -v ON_ERROR_STOP=1 -f db/tests/004_auth_test.sql
```

## Lizenzserver (läuft bei dir, Node >= 22.18, keine Pakete nötig)

```bash
cd license-server
npm run create-admin -- ahmed@example.tn     # Passwort wird abgefragt
npm start                                    # Portal: http://127.0.0.1:8443/admin (davor TLS-Proxy, z. B. Caddy)
npm test                                     # 10 Tests
```

Beim ersten Start entsteht `data/keys/license-signing.key`. **Dieser Schlüssel ist das wichtigste Geheimnis des Systems** – offline sichern, nie ins Repo.

## Kundenserver (Backend) einrichten

```bash
cd backend
npm install && npm run build
npm run test:core                            # 16 Tests Lizenz + Login (laufen auch ohne npm install)

# 1. Im Lizenzportal Kunden anlegen -> Installations-ID + Secret notieren
# 2. Installation an den Mandanten binden (einmalig, als DB-Owner):
psql -d warenwirtschaft -c "SELECT auth.setup_installation('<Installations-ID>', '<tenant-uuid>')"
# 3. Umgebung setzen und starten
export DATABASE_URL=postgres://app_user:bitte-ändern@localhost/warenwirtschaft
export LICENSE_SERVER_URL=https://lizenz.deine-domain.tn
export LICENSE_PUBLIC_KEY_FILE=keys/license.pub     # Kopie von license-signing.pub
export INSTALLATION_SECRET=<Secret aus dem Portal>
npm start                                    # Access-Token-Schlüssel wird beim ersten Start erzeugt

# Integrationstest (echte App + DB + Lizenzserver im Prozess)
export ADMIN_DATABASE_URL=postgres://postgres@localhost/warenwirtschaft
npm run test:integration
```

## Ablauf Geräte-Freischaltung

1. App auf neuem Gerät erzeugt ein Schlüsselpaar (privater Schlüssel bleibt im Gerät) und schickt eine Anfrage an den Lizenzserver.
2. Du siehst im Portal Kunde, Gerät und Code und schaltest frei (Gerätelimit laut Vertrag wird geprüft).
3. Das Gerät erhält ein signiertes Zertifikat. Anmeldung am Kundenserver = Zertifikat + signierte Einmal-Challenge + Passwort/PIN.
4. Sperren im Portal wirkt beim nächsten stündlichen Abgleich; der Inhaber kann zusätzlich lokal sofort sperren.

## API

| Methode | Pfad | Recht | Zweck |
| --- | --- | --- | --- |
| GET | `/health` | öffentlich | Erreichbarkeit |
| POST | `/api/v1/auth/challenge` | öffentlich | Einmal-Challenge (60 s) |
| POST | `/api/v1/auth/login` | öffentlich + Gerätezertifikat | Passwort (Inhaber/Filialleiter) oder PIN (Kasse/Lager an Kasse/Scanner/Tablet) |
| POST | `/api/v1/auth/refresh`, `/auth/logout` | Refresh-Token | Rotation, Abmelden |
| GET | `/api/v1/license/status` | angemeldet | aktiv / Warnung / Nur-Lesen mit Begründung |
| POST | `/api/v1/sync/push` | `stock.read` + Recht je Buchungsart | Offline-Queue eines Geräts hochladen; Antwort je Bewegung `accepted` / `duplicate` / `rejected` |
| GET | `/api/v1/sync/pull?storeId=&since=` | `stock.read` | Verpasste Bewegungen seit Cursor + aktuelle Bestände |
| GET | `/api/v1/stores/:id/stock-alerts` | `report.stock` | Mindestbestand- und MHD-Warnungen (7 Tage) |
| WS | `/live` (Socket.IO, `auth.token`) | gültiges Token | Event `stock.changed`, nur für eigene Filialen |

## Sicherheitsprinzip in einem Satz

Die API setzt pro Anfrage `app.tenant_id`, `app.role` und `app.store_ids` per `SET LOCAL`; PostgreSQL filtert jede Zeile selbst (RLS, `FORCE`), die App-Rolle `app_user` kann das nicht umgehen.

## Nächste Schritte

1. 2FA (TOTP) für Inhaber und Filialleiter, Benutzerverwaltung im Backoffice.
2. Produktmodul: CRUD, Barcode-Suche, Gebinde, mehrsprachige Namen.
3. Expo-App: Freischaltungs-Bildschirm, Anmeldung, RTL (Arabisch), lokale SQLite + Sync.
