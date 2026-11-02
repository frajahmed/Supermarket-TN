# Aufgaben (gepflegt von Claude, umgesetzt von Codex)

CI auf GitHub (`.github/workflows/ci.yml`) führt bei jedem Push `scripts/test-all.sh` aus – ein Pull Request wird nur mit grünem Lauf gemergt.

Status: `offen` → `in Arbeit (Codex)` → `zur Prüfung` → `erledigt` (nur Claude setzt `erledigt`) oder `zurück an Codex` (mit Befund).
Reihenfolge = Priorität. Abhängigkeiten stehen bei der Aufgabe. Regeln und Definition of Done: siehe `AGENTS.md`.

## Erledigt

| ID | Inhalt | Nachweis |
| --- | --- | --- |
| T-001 | Grundschema, RLS, Bestandsjournal, Outbox (`db/001`, `db/002`) | `db/tests/001_rls_test.sql` (T1–T11) |
| T-002 | Großhandel: Kunden, Preislisten, Rechnungen, Kreditlimit (`db/003`) | `db/tests/003_wholesale_test.sql` (W0–W7) |
| T-003 | Lizenzserver + Verwaltungsportal | `license-server/test/` (10 Tests) |
| T-004 | Login mit Gerätezertifikat, PIN, Refresh-Rotation (`db/004`, `backend/src/core`) | `backend/test-core/` (16), `db/tests/004_auth_test.sql` (A1–A6) |
| T-101 | Produkt-API: Suche, Barcode/GTIN-Scan, Gebinde, Preisrecht, Audit (`db/005`) – PR #1 | `db/tests/005_product_barcode_test.sql` (P1–P4), NestJS-Integrationstests |

---

## T-107 · Einkaufspreise nach Rolle verbergen (aus Prüfung von T-101)
**Status:** zur Prüfung · **Priorität:** höchste – vor jedem Kundeneinsatz · **Abhängig von:** –

Befund: `GET /products` und `GET /products/by-barcode/:code` liefern `purchasePrice` an alle Rollen. Laut Berechtigungsmatrix dürfen nur Rollen mit Recht `report.finance` (Inhaber, Filialleiter) Einkaufspreise sehen.

- Antworten der Produkt-Endpunkte: `purchasePrice` nur mit Recht `report.finance`, sonst Feld **weglassen** (nicht `null`). Gilt für Liste, Barcode-Scan, Anlegen/Ändern-Antwort und künftige Endpunkte – zentral in einer Funktion lösen, nicht pro Endpunkt.
- `q` in der Suche: `%`, `_` und `\` escapen (`ILIKE … ESCAPE '\'`).
- `createPackaging`: Konfliktmeldung anhand des verletzten Constraints wählen (Gebinde-Code vs. GTIN).
- Anlegen mit Preis schreibt ebenfalls einen Audit-Eintrag (`price.update`, `before` = null).

Abnahmekriterien:
1. Test: Kassierer und Lagerist erhalten in Liste und Scan **kein** Feld `purchasePrice`; Inhaber und Filialleiter schon.
2. Test: Suche nach `50%` findet nur Produkte mit „50%“ im Namen, nicht alle mit „50“.
3. Test: Konflikt beim Gebinde-Code liefert 409 „Gebinde-Code …“, auch wenn eine GTIN mitgeschickt wird.
4. Test: Anlegen mit `salePrice` erzeugt einen Audit-Eintrag.

Umsetzung: Einkaufspreise werden zentral anhand von `report.finance` aus Produktantworten entfernt; Literalsuche escaped `%`, `_` und `\\`; Gebinde-Konflikte unterscheiden Constraint-basiert Gebinde-Code und GTIN; Produktanlage mit Preis schreibt `price.update` mit `before = null` in das Audit-Log.
Neue Tests: erweiterte NestJS-Integrationstests für Rollen-Sichtbarkeit in Liste/Scan/Ändern, Literalsuche, Gebinde-Code-Konflikt und Erstellungs-Audit.
Offene Fragen: keine.

## T-102 · Benutzerverwaltung und 2FA
**Status:** offen · **Abhängig von:** –

- `GET/POST/PATCH /api/v1/users`: Inhaber verwaltet alle; Filialleiter nur `stock_clerk`/`cashier` in eigenen Filialen (siehe Berechtigungsmatrix im Architektur-Dokument).
- Passwort setzen/zurücksetzen (min. 10 Zeichen), Kassen-PIN setzen (4–8 Ziffern). Hashing über `hashSecret()` aus `shared/license-core.ts`.
- Filialzuordnung pflegen (`app.user_store_access`).
- **TOTP-2FA** für `owner` und `manager` (RFC 6238, 30 s, 6 Ziffern, mit `node:crypto` umgesetzt, keine Bibliothek). Geheimnis verschlüsselt in `users.totp_secret_enc`. Login verlangt den Code, sobald 2FA eingerichtet ist. Neue Migration `db/005_…` falls Spalten fehlen.
- Benutzer deaktivieren beendet sofort alle Refresh-Tokens.

Abnahmekriterien:
1. Filialleiter kann keinen Inhaber/Filialleiter anlegen und keine Nutzer fremder Filialen ändern (403, Test).
2. TOTP: gültiger Code ±1 Zeitfenster akzeptiert, alter Code im selben Fenster nicht zweimal (Replay-Schutz), Test mit festen RFC-6238-Testvektoren.
3. Deaktivierter Nutzer: nächstes `/auth/refresh` → 401 (Test).

## T-103 · Expo-App: Freischaltung, Anmeldung, Sprachen
**Status:** offen · **Abhängig von:** T-102 (2FA-Feld im Login)

Neuer Ordner `app/` (Expo, TypeScript, expo-router):
- **Erststart:** Schlüsselpaar Ed25519 erzeugen, privater Schlüssel in `expo-secure-store` (Hardware-gestützt, wo verfügbar). Kundenserver-Adresse per QR-Code oder Eingabe; Installations-ID kommt vom Kundenserver (`GET /api/v1/setup/info`, neuer öffentlicher Endpunkt).
- **Freischalt-Bildschirm:** zeigt den Aktivierungscode groß und fragt alle 5 s den Status ab. Nach Freigabe wird das Zertifikat gespeichert.
- **Anmeldung:** E-Mail + Passwort (+ TOTP) oder Benutzerauswahl + PIN-Tastatur an Kasse/Scanner/Tablet; Challenge signieren.
- **i18n:** ar/fr/en mit i18next; Arabisch schaltet RTL (`I18nManager`). Beträge über `Intl.NumberFormat` mit 3 Stellen für TND.
- **Lizenz-Banner** aus `/license/status` (Warnung gelb, Nur-Lesen rot).

Abnahmekriterien:
1. Unit-Tests für Signatur/Challenge mit denselben Testvektoren wie `shared/license-core.ts` (Kompatibilität App ↔ Server).
2. Sprache wechseln ändert die Layoutrichtung ohne Datenverlust.
3. Kein Geheimnis in AsyncStorage oder Logs (Code-Review durch Claude).

## T-104 · Offline-Sync in der App
**Status:** offen · **Abhängig von:** T-103

- Lokale SQLite (verschlüsselt): Produkte, Barcodes, Bestand der eigenen Filiale, Sync-Queue.
- Buchungen offline erfassen (`client_op_id` = UUID v7), Push in Stapeln ≤ 500, Pull mit Cursor, WebSocket für Live-Updates.
- Abgelehnte Buchungen (`rejected`) sichtbar mit Grund.

Abnahmekriterien:
1. Test: 200 Buchungen offline, Verbindung wieder da → alle genau einmal auf dem Server (Idempotenz).
2. Test: zwei Geräte buchen offline auf dasselbe Produkt → Endbestand = Summe beider.

## T-105 · B2B-Verkauf: Auftrag → Lieferschein → Rechnung
**Status:** offen · **Abhängig von:** T-101

- API für `sales_orders` (anlegen, bestätigen, liefern), Preis über `app.price_for()`.
- Lieferung bucht Bestand (`sale`-Bewegung je Position, `ref_type = 'sales_order'`).
- Rechnung aus Lieferung erzeugen und über `app.issue_invoice()` ausstellen; Gutschrift (`AV`-Serie) mit Bezug.
- PDF von Rechnung und Lieferschein (fr + ar), Matricule fiscal beider Seiten, TVA je Satz, Timbre.

Abnahmekriterien:
1. Kreditlimit blockiert die Bestätigung eines Auftrags (nicht erst die Rechnung). Inhaber kann mit Begründung übersteuern (Audit-Eintrag).
2. Teillieferung: Rechnung nur über die gelieferte Menge.
3. PDF-Snapshot-Test: Summen im PDF = Summen in `sales_invoices`.

## T-106 · TTN/El Fatoora-Anbindung (vorbereiten)
**Status:** blockiert – offizielle TEIF-Spezifikation und Testzugang fehlen (Ahmed besorgt)

- Erst wenn Spezifikation vorliegt: TEIF-XML-Erzeugung, Signatur, Versand an TTN-Testumgebung, Statusrückmeldung in `sales_invoices.ttn_status`.
- Bis dahin: nur Schnittstelle `TtnClient` mit Fake-Implementierung für Tests.

---

## Prüfprotokoll (Claude)

| Datum | Aufgabe | Ergebnis | Befund |
| --- | --- | --- | --- |
| 2026-11-01 | T-001 … T-004 | erledigt | Ausgangsstand: 33 SQL-Prüfungen, 26 Node-Tests grün |
| 2026-11-02 | T-101 (PR #1) | erledigt | CI 16/16 grün, 0 übersprungen (inkl. 11 NestJS-Integrationstests). Alle 5 Kriterien erfüllt. Befund Einkaufspreis-Sichtbarkeit → T-107. Positiv: Startreihenfolge-Fehler in Lizenz/Auth behoben. |
