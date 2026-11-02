# Aufgaben (gepflegt von Claude, umgesetzt vom Entwicklungs-Agenten – derzeit Antigravity)

CI auf GitHub (`.github/workflows/ci.yml`) führt bei jedem Push `scripts/test-all.sh` aus – ein Pull Request wird nur mit grünem Lauf gemergt.

Status: `offen` → `in Arbeit (Agent)` → `zur Prüfung` → `erledigt` (nur Claude setzt `erledigt`) oder `zurück an Agent` (mit Befund).
Reihenfolge = Priorität. Abhängigkeiten stehen bei der Aufgabe. Regeln und Definition of Done: siehe `AGENTS.md`.

**Nächste Aufgabe:** T-103 (Nachbesserung), danach T-105.

## Erledigt

| ID | Inhalt | Nachweis |
| --- | --- | --- |
| T-001 | Grundschema, RLS, Bestandsjournal, Outbox (`db/001`, `db/002`) | `db/tests/001_rls_test.sql` (T1–T11) |
| T-002 | Großhandel: Kunden, Preislisten, Rechnungen, Kreditlimit (`db/003`) | `db/tests/003_wholesale_test.sql` (W0–W7) |
| T-003 | Lizenzserver + Verwaltungsportal | `license-server/test/` (10 Tests) |
| T-004 | Login mit Gerätezertifikat, PIN, Refresh-Rotation (`db/004`, `backend/src/core`) | `backend/test-core/` (16), `db/tests/004_auth_test.sql` (A1–A6) |
| T-101 | Produkt-API: Suche, Barcode/GTIN-Scan, Gebinde, Preisrecht, Audit (`db/005`) – PR #1 | `db/tests/005_product_barcode_test.sql` (P1–P4), NestJS-Integrationstests |
| T-102 | Benutzerverwaltung, Filialrechte, TOTP-2FA mit Replay-Schutz (`db/006`) – PR #3 | `db/tests/006_…`, `backend/test-core/totp.test.ts`, NestJS-Integrationstest |
| T-108 | 2FA-Fehlversuche zählen, 2FA-Selbsteinrichtung, letzter Inhaber geschützt, gemischte Filialen (`db/007`) – PR #5 | `db/tests/007_…` (O1–O7), Kern- und Integrationstests, Gleichzeitigkeitstest |
| T-107 | Einkaufspreise nur mit `report.finance`, Literalsuche, Konfliktmeldungen, Audit beim Anlegen – PR #2 | NestJS-Integrationstest „T-107“ |

---

## T-103 · Expo-App: Freischaltung, Anmeldung, Sprachen
**Status:** zurück an Agent (PR #4, Branch `codex/T-103-app` weiterverwenden) · **Abhängig von:** T-102 (erledigt)

**Befunde aus der Prüfung (alle beheben, Details im Kommentar zu PR #4):**
1. Blockierend: `tweetnacl` ohne Zufallsquelle → Schlüsselerzeugung wirft auf dem Gerät „no PRNG“. `expo-crypto` + `nacl.setPRNG(...)`, mit Test.
2. Blockierend: `forceRTL` wirkt erst nach Reload → Sprache speichern, beim Start anwenden, nach Wechsel neu laden, Eingaben sichern.
3. Blockierend: App-Typprüfung (`tsc -p app/tsconfig.json`) fehlt in `scripts/test-all.sh`/CI.
4. Feste deutsche Texte → i18n-Schlüssel.
5. Fehlerbehandlung in `startSetup()`, Polling nach Freigabe stoppen und zur Anmeldung wechseln.
6. Server-Adresse nur `https://` (außer `__DEV__`).

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
| 2026-11-02 | T-107 (PR #2) | erledigt | CI grün, alle 4 Kriterien erfüllt, Constraint-Name gegen DB verifiziert. Keine Befunde. |
| 2026-11-02 | T-102 (PR #3) | erledigt (nachträglich geprüft) | Ohne vorherige Prüfung gemergt. CI grün, alle 3 Kriterien erfüllt. Befunde: 2FA ohne Fehlversuch-Zählung durchprobierbar, Einrichtung durch Ersteller, letzter Inhaber, gemischte Filialen → T-108. |
| 2026-11-03 | T-103 (PR #4) | zurück an Agent | CI grün, aber nur Logik getestet. Blockierend: keine Zufallsquelle für Schlüsselerzeugung auf dem Gerät, RTL erst nach Neustart, App-Typprüfung fehlt in CI. Dazu i18n, Fehlerbehandlung, HTTPS. |
| 2026-11-03 | T-108 (PR #5) | erledigt (von Claude umgesetzt) | CI 18/18 grün. Lücke bei gemischten Filialen (RLS verbirgt fremde Zuordnungen) während der Umsetzung durch CI gefunden und behoben. |
