# AGENTS.md – Anweisungen für Codex (Supermarket-TN)

Diese Datei liest Codex automatisch. Sie beschreibt das Projekt, die festen Architekturregeln, die Befehle und den Arbeitsablauf.
**Rollen:** Codex entwickelt. Claude ist Projektmanager und Tester: Claude schreibt die Aufgaben in `docs/TASKS.md`, prüft jede Lieferung mit `scripts/test-all.sh` und gibt sie frei oder schickt sie mit Befund zurück. Ahmed (Inhaber) entscheidet fachlich.

---

## 1. Was wir bauen

Warenwirtschaft, Großhandel und Kasse für Händler in **Tunesien**, vermietet an ca. 30 Kunden.

- Jeder Kunde hat einen **eigenen Server im Laden** (Mini-PC). Alle Geschäftsdaten bleiben dort. Es gibt keine Cloud-Datenbank.
- Ahmed betreibt nur den **Lizenzserver**: Mietverträge und Geräte-Freischaltung. Er enthält keine Geschäftsdaten.
- Geräte (Handy, Scanner-Handheld, Tablet, Kasse) brauchen ein **Gerätezertifikat** vom Lizenzserver und danach eine Benutzeranmeldung.
- Erster Kunde: **Mittel- bis Großhändler**. B2B (Kunden auf Rechnung, Preislisten, TTN-E-Rechnung) hat Vorrang vor der Kasse.
- Sprachen **Arabisch (RTL), Französisch, Englisch**. Währung **TND mit 3 Nachkommastellen**.

## 2. Feste Architekturregeln (nicht verhandelbar)

Ein Verstoß gegen eine dieser Regeln führt zur Ablehnung, auch wenn alle Tests grün sind.

1. **Mandantentrennung über PostgreSQL-RLS.** Jede fachliche Tabelle hat `tenant_id`, `ENABLE` + `FORCE ROW LEVEL SECURITY` und eine Policy. Die App verbindet sich als `app_user` (ohne BYPASSRLS). Fachliche Abfragen laufen nur über `DbService.withTenant()`.
2. **Vor dem Login** (kein Mandantenkontext) nur eng begrenzte `SECURITY DEFINER`-Funktionen im Schema `auth` mit `SET search_path = app, pg_temp`. Niemals RLS umgehen, um etwas „einfacher“ zu machen.
3. **Bestand ändert sich nur über das Journal** `app.stock_movements` (nur anhängen). Korrekturen sind Gegenbuchungen. Ausgestellte Rechnungen, Zahlungen und das Audit-Log sind unveränderlich.
4. **Geld = Ganzzahl in Minor Units** (`bigint` in SQL, `bigint`/String in TS) plus ISO-4217-Code. TND = 3 Stellen, EUR/USD = 2. Niemals `float`/`number` für Beträge. Mengen als `numeric(14,3)` bzw. String.
5. **Offline-First:** Schreibende Geräte-Operationen tragen eine vom Client erzeugte `client_op_id` (UUID v7) und sind idempotent.
6. **Lizenz:** Gerätezertifikate (Ed25519) und Lizenzbestätigungen werden vom Lizenzserver signiert. Keine Bindung an IP- oder MAC-Adresse. Nach Mietende oder mehr als 14 Tagen ohne Lizenzabgleich nur Lesen. Die Daten des Kunden werden nie gelöscht.
7. **Rollen:** genau 4 (`owner`, `manager`, `stock_clerk`, `cashier`). Code prüft **Rechte** (`app.permissions`), nicht Rollennamen. Die DB-Policy ist die zweite Verteidigungslinie.
8. **Migrationen:** `db/001_…` bis `db/004_…` sind angewendet und werden **nie geändert**. Jede Schemaänderung kommt als neue Datei `db/NNN_name.sql` (fortlaufend, in `BEGIN; … COMMIT;`) und bringt einen Test `db/tests/NNN_name_test.sql` mit.
9. **`license-server/` und `shared/` haben null externe Abhängigkeiten** (nur Node ≥ 22.18). `backend/src/core/` bleibt frei von NestJS, damit es ohne `npm install` testbar ist.
10. **Keine Geheimnisse im Repo:** keine `.key`, `.pem`, `.env`, keine Installations-Secrets.

## 3. Repository

| Pfad | Inhalt |
| --- | --- |
| `db/` | PostgreSQL-Migrationen (`001_schema` … `004_auth_devices`) und SQL-Tests in `db/tests/` |
| `shared/license-core.ts` | Signierte Tokens, Challenge-Besitznachweis, scrypt-Hashing (Lizenzserver und Kundenserver) |
| `license-server/` | Lizenzserver: `src/service.ts` (Logik), `src/http.ts` (Routen), `src/admin-page.ts` (Portal), Tests in `test/` |
| `backend/src/core/` | Framework-freier Kern: `license-gate.ts`, `auth-flow.ts`, `jwt.ts`; Tests in `backend/test-core/` |
| `backend/src/` | NestJS-Kundenserver: `db/`, `auth/`, `licensing/`, `inventory/`, `realtime/`, `common/` |
| `docs/TASKS.md` | Aufgabenliste mit Abnahmekriterien (Quelle der Wahrheit für die nächste Arbeit) |
| `scripts/test-all.sh` | Gesamtprüfung, die Claude vor jeder Freigabe ausführt |

## 4. Befehle

```bash
# Alles prüfen (genau das, was Claude bei der Abnahme ausführt)
bash scripts/test-all.sh

# Einzeln
cd license-server && npm test                      # Lizenzserver
cd backend && npm run test:core                    # Lizenz + Login, ohne npm install
cd backend && npm install && npm run build && npm run test:integration   # NestJS + DB (braucht DB-Variablen)

# Datenbank (Wegwerf-DB, Superuser-Verbindung über PGHOST/PGPORT/PGUSER)
for f in db/[0-9]*.sql; do psql -d stn_test -v ON_ERROR_STOP=1 -q -f "$f"; done
for t in db/tests/*.sql; do psql -d stn_test -v ON_ERROR_STOP=1 -q -f "$t"; done
```

TypeScript wird von Node direkt ausgeführt (Type Stripping): Nur löschbare Syntax verwenden (`erasableSyntaxOnly`). Also kein `enum`, kein `namespace`, keine Constructor-Parameter-Properties in `core/`, `shared/` und `license-server/`. Relative Importe mit Endung `.ts`.

## 5. Arbeitsablauf je Aufgabe

1. Aufgabe aus `docs/TASKS.md` nehmen (Status `offen`) und auf `in Arbeit (Codex)` setzen.
2. Branch `codex/<Aufgaben-ID>-kurzname`, z. B. `codex/T-101-produkte`.
3. Umsetzen. Tests gehören zum gleichen Commit wie der Code.
4. `bash scripts/test-all.sh` muss mit `ALLE PRÜFUNGEN BESTANDEN` enden.
5. In `docs/TASKS.md` den Status auf `zur Prüfung` setzen und unter der Aufgabe kurz notieren: was gebaut wurde, welche Tests neu sind, offene Punkte.
6. Pull Request gegen `main`. Titel `T-101: …`. Claude prüft und merged; Codex merged nicht selbst.

### Definition of Done (Claude prüft jeden Punkt)

- [ ] Alle Abnahmekriterien der Aufgabe erfüllt und durch Tests belegt
- [ ] `scripts/test-all.sh` grün, keine übersprungenen Tests ohne Begründung
- [ ] Neue Tabellen: `tenant_id`, RLS (`ENABLE` + `FORCE`), Policy, Grants, Test „anderer Mandant sieht nichts“
- [ ] Neue Endpunkte: `@RequirePermission(...)`, Zod-Validierung, Test für 401/403
- [ ] Beträge in Minor Units, Texte für Nutzer über i18n-Schlüssel (ar/fr/en)
- [ ] Keine Änderung an `db/001`–`db/004`, keine Geheimnisse, keine neuen Pakete in `license-server/`/`shared/`
- [ ] Kommentare und Fehlermeldungen auf Deutsch, Code-Bezeichner auf Englisch

## 6. Stil

- TypeScript `strict`. Keine `any` in neuem Code außer in Tests.
- Fehlermeldungen an Nutzer: kurz, ohne interne Details (keine SQL-Fehler nach außen).
- Logs ohne personenbezogene Daten und ohne Tokens.
- Commit-Nachrichten auf Deutsch, erste Zeile ≤ 72 Zeichen, z. B. `T-101: Produkt-API mit Barcode-Suche`.

## 7. Bekannte Einschränkungen

- Das TEIF-Format von TTN (E-Rechnung) ist noch nicht offiziell spezifiziert im Repo. Nichts erfinden: Struktur nur nach offizieller Spezifikation umsetzen, sonst als offene Frage in `docs/TASKS.md` notieren.
- Steuersätze (19/13/7 %) und Timbre (Standard 1,000 TND) sind konfigurierbar und noch nicht von einem Steuerberater bestätigt.
