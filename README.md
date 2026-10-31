# Supermarket-TN – Warenwirtschaft, Großhandel & Kasse

Supermarkt- und Großhandelssoftware, erster Markt Tunesien (Arabisch, Französisch, Englisch, TND).
Betrieb: ein lokaler Server pro Kunde, Zugriff im Laden über WLAN/LAN, von unterwegs über Tunnel.

## Inhalt

| Pfad | Inhalt | Status |
| --- | --- | --- |
| `db/001_schema.sql` | Vollständiges Schema: Mandanten, Filialen, 4 Rollen + Rechtekatalog, Produkte (mehrsprachig, Allergene, Nährwerte, MHD-Chargen), Bestandsjournal mit Trigger, Einkauf, Belege (TEIF/QR/OCR), Kasse mit Fiskal-Feldern, Outbox, Audit, RLS-Policies, Dashboard-Views | getestet gegen PostgreSQL 16 |
| `db/002_outbox_claim.sql` | Abholung der Echtzeit-Events für den Worker | getestet |
| `db/003_wholesale.sql` | Großhandel: Geschäftskunden (Matricule fiscal), Kundengruppen, Preislisten mit Staffeln, Gebinde, Aufträge, Ausgangsrechnungen (lückenlos nummeriert, unveränderlich, TVA je Satz, Timbre, TTN-Status), Zahlungen, Kreditlimit | getestet |
| `db/tests/001_rls_test.sql` | 12 Prüfungen (T1–T11): Isolation, Filialrechte, Kassierer-Sperre, Idempotenz, unveränderliches Journal, Login-Lookup, Outbox | alle bestanden |
| `db/tests/003_wholesale_test.sql` | 8 Prüfungen (W0–W7): Preisstaffeln, Rechnungssummen, Nummernkreis ohne Lücken, Unveränderlichkeit, Kreditlimit, Kassierer, Mandantentrennung | alle bestanden |
| `backend/` | NestJS-Kern: DB-Zugang mit RLS-Kontext, JWT-Guard (EdDSA), Rechteprüfung, Offline-Sync Push/Pull, Bestandswarnungen, WebSocket-Gateway, Outbox-Worker, Geldlogik (TND = 3 Stellen) | Geldlogik und alle SQL-Abfragen geprüft; Kompilieren + Integrationstest noch lokal auszuführen (siehe unten) |

## Datenbank aufsetzen

```bash
createdb warenwirtschaft
psql -d warenwirtschaft -v ON_ERROR_STOP=1 -f db/001_schema.sql -f db/002_outbox_claim.sql -f db/003_wholesale.sql
psql -d warenwirtschaft -c "ALTER ROLE app_user LOGIN PASSWORD 'bitte-ändern'"

# Tests (laufen in einer Transaktion, hinterlassen nichts)
psql -d warenwirtschaft -v ON_ERROR_STOP=1 -f db/tests/001_rls_test.sql
psql -d warenwirtschaft -v ON_ERROR_STOP=1 -f db/tests/003_wholesale_test.sql
```

## Backend starten

```bash
cd backend
npm install
npm run build

# Ed25519-Schlüsselpaar für Tokens (privater Schlüssel nur für den Login-Dienst)
openssl genpkey -algorithm ed25519 -out jwt-private.pem
openssl pkey -in jwt-private.pem -pubout -out jwt-public.pem

export DATABASE_URL=postgres://app_user:bitte-ändern@localhost/warenwirtschaft
export JWT_PUBLIC_KEY="$(cat jwt-public.pem)"
npm start                      # http://127.0.0.1:3000/health

# Integrationstest (echte App + echte DB, inkl. WebSocket-Live-Event)
export ADMIN_DATABASE_URL=postgres://postgres@localhost/warenwirtschaft
npm run test:integration
```

## API (Phase 0)

| Methode | Pfad | Recht | Zweck |
| --- | --- | --- | --- |
| GET | `/health` | öffentlich | Erreichbarkeit |
| POST | `/api/v1/sync/push` | `stock.read` + Recht je Buchungsart | Offline-Queue eines Geräts hochladen; Antwort je Bewegung `accepted` / `duplicate` / `rejected` |
| GET | `/api/v1/sync/pull?storeId=&since=` | `stock.read` | Verpasste Bewegungen seit Cursor + aktuelle Bestände |
| GET | `/api/v1/stores/:id/stock-alerts` | `report.stock` | Mindestbestand- und MHD-Warnungen (7 Tage) |
| WS | `/live` (Socket.IO, `auth.token`) | gültiges Token | Event `stock.changed`, nur für eigene Filialen |

## Sicherheitsprinzip in einem Satz

Die API setzt pro Anfrage `app.tenant_id`, `app.role` und `app.store_ids` per `SET LOCAL`; PostgreSQL filtert jede Zeile selbst (RLS, `FORCE`), die App-Rolle `app_user` kann das nicht umgehen.

## Nächste Schritte (Phase 1)

1. Login-Dienst: Passwort (Argon2id), Kassen-PIN, Refresh-Token-Rotation, 2FA für Inhaber/Filialleiter.
2. Produktmodul: CRUD, Barcode-Lookup, mehrsprachige Namen, Kategorien, Lieferanten.
3. Expo-App-Grundgerüst mit RTL (Arabisch), lokaler SQLite und Sync-Queue.
4. Backoffice-Dashboard mit Live-Bestand.
