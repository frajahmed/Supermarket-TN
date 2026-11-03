# Aufgaben (gepflegt von Claude, umgesetzt vom Entwicklungs-Agenten – derzeit Antigravity)

CI auf GitHub (`.github/workflows/ci.yml`) führt bei jedem Push `scripts/test-all.sh` aus – ein Pull Request wird nur mit grünem Lauf gemergt.

Status: `offen` → `in Arbeit (Agent)` → `zur Prüfung` → `erledigt` (nur Claude setzt `erledigt`) oder `zurück an Agent` (mit Befund).
Reihenfolge = Priorität. Abhängigkeiten stehen bei der Aufgabe. Regeln und Definition of Done: siehe `AGENTS.md`.

**Nächste Aufgabe:** T-111, danach in Reihenfolge T-112 bis T-116. T-117 (Gerätetest) läuft parallel bei Ahmed.

## Erledigt

| ID | Inhalt | Nachweis |
| --- | --- | --- |
| T-001 | Grundschema, RLS, Bestandsjournal, Outbox (`db/001`, `db/002`) | `db/tests/001_rls_test.sql` (T1–T11) |
| T-002 | Großhandel: Kunden, Preislisten, Rechnungen, Kreditlimit (`db/003`) | `db/tests/003_wholesale_test.sql` (W0–W7) |
| T-003 | Lizenzserver + Verwaltungsportal | `license-server/test/` (10 Tests) |
| T-004 | Login mit Gerätezertifikat, PIN, Refresh-Rotation (`db/004`, `backend/src/core`) | `backend/test-core/` (16), `db/tests/004_auth_test.sql` (A1–A6) |
| T-101 | Produkt-API: Suche, Barcode/GTIN-Scan, Gebinde, Preisrecht, Audit (`db/005`) – PR #1 | `db/tests/005_product_barcode_test.sql` (P1–P4), NestJS-Integrationstests |
| T-102 | Benutzerverwaltung, Filialrechte, TOTP-2FA mit Replay-Schutz (`db/006`) – PR #3 | `db/tests/006_…`, `backend/test-core/totp.test.ts`, NestJS-Integrationstest |
| T-103 | Expo-App: Freischaltung (Gerätetyp, Code, Polling), Anmeldung (Passwort/PIN/2FA), ar/fr/en mit RTL ohne Neustart, nur HTTPS – PR #4 | `app/test/` (12 Tests), App-Typprüfung in CI |
| T-105 | B2B-Verkauf: Auftrag mit Kreditprüfung, Teillieferung + Lager, Rechnung je Lieferung, Gutschrift, Dokumente fr+ar (`db/008`) – PR #6 | `db/tests/008_sales_flow_test.sql` (S1–S9), Dokument- und Integrationstests |
| T-108 | 2FA-Fehlversuche zählen, 2FA-Selbsteinrichtung, letzter Inhaber geschützt, gemischte Filialen (`db/007`) – PR #5 | `db/tests/007_…` (O1–O7), Kern- und Integrationstests, Gleichzeitigkeitstest |
| T-109 | App-Grundgerüst: `GET /me`, Sitzung mit Token-Erneuerung (einmal, gemeinsam), Abmelden, Startseite nach Rechten, Lizenzbanner, Filialauswahl – PR #7 | `app/test/session.test.ts` (10 Tests), NestJS-Integrationstest „T-109“ |
| T-110 | Produkte in der App: Bestandsliste je Filiale (`GET /stores/:id/stock`), Detail mit Chargen/Gebinden, Kamera-Scan, Anlegen/Ändern – PR #8 | `app/test/products.test.ts` (7 Tests), NestJS-Integrationstest „T-110“ |
| T-107 | Einkaufspreise nur mit `report.finance`, Literalsuche, Konfliktmeldungen, Audit beim Anlegen – PR #2 | NestJS-Integrationstest „T-107“ |

---

## Plan App (Stand 2026-11-03)

Das Backend ist bis auf Kasse und Zahlungen fertig; die App kann bisher nur freischalten und anmelden. Reihenfolge nach Nutzen für den ersten Kunden (Großhändler). Jede Aufgabe enthält die nötigen Backend-Endpunkte gleich mit. Gemeinsame Regeln für alle App-Aufgaben:
- Logik in `app/src/core` (reines TypeScript, mit Node getestet); Bildschirme bleiben dünn.
- Texte nur über i18n (ar/fr/en), Beträge mit 3 Stellen, Schreibrichtung aus `useLanguage()`.
- Rechte kommen vom Server (`GET /me`); die App blendet aus, was die Rolle nicht darf – der Server prüft trotzdem.

## T-109 · App-Grundgerüst nach der Anmeldung
**Status:** erledigt (PR #7) · **Abhängig von:** T-103

- Backend: `GET /api/v1/me` → Benutzer, Rolle, Rechte-Liste, Filialen (Name, Code), Lizenzstatus.
- App: Sitzung mit automatischem Token-Erneuern (`/auth/refresh` vor Ablauf und bei 401, einmal), Abmelden (`/auth/logout`, Sitzung löschen).
- Startseite nach Rolle mit Kacheln nur für erlaubte Bereiche; Filialauswahl, wenn mehrere Filialen.
- Lizenzbanner auf jeder Seite (Warnung gelb, Nur-Lesen rot), schreibende Aktionen im Nur-Lesen-Modus ausgegraut.

Abnahmekriterien:
1. Test: abgelaufenes Access-Token → genau ein Refresh, danach Wiederholung der Anfrage; zweites 401 → Abmelden.
2. Test: Kacheln je Rolle (Kassierer sieht weder Aufträge noch Benutzer).
3. Integrationstest `GET /me` für alle vier Rollen.

## T-110 · Produkte, Scan und Bestand
**Status:** erledigt (PR #8) · **Abhängig von:** T-109

- Backend: `GET /api/v1/stores/:id/stock?q=&cursor=` (Produkt, Bestand, Mindestbestand, nächstes MHD); Einkaufspreis nur mit `report.finance` (wie T-107).
- App: Produktsuche, Kamera-Scan (`expo-camera`, EAN-13/EAN-8/Code128/QR) → `GET /products/by-barcode`, Produktdetail mit Bestand und Gebinden; Produkt anlegen/ändern für Rollen mit `product.write`.

Abnahmekriterien:
1. Test: Scan eines Karton-GTIN zeigt Faktor und Menge je Scan.
2. Test: unbekannter Barcode → Angebot „Produkt anlegen“ mit vorausgefülltem Barcode.
3. Integrationstest Bestandsliste: Kassierer sieht keinen Einkaufspreis, fremde Filiale → 403.

## T-111 · Kunden (Großhandel)
**Status:** offen · **Abhängig von:** T-109

- Backend: `GET/POST/PATCH /api/v1/customers` (Suche Name/Nummer/Matricule fiscal, Recht `customer.manage` zum Schreiben), `GET /customers/:id` mit offenem Saldo (`v_customer_balance`), Kreditlimit, Zahlungsziel, Kundengruppe/Preisliste.
- App: Kundenliste mit Suche, Kundendetail (Saldo, Limit, letzte Aufträge/Rechnungen), anlegen/ändern.

Abnahmekriterien:
1. Test: Geschäftskunde ohne Matricule fiscal → 400 mit verständlicher Meldung.
2. Test: Lagerist kann lesen, aber nicht ändern; Kassierer hat keinen Zugriff.

## T-112 · Aufträge, Lieferung und Rechnung in der App
**Status:** offen · **Abhängig von:** T-110, T-111

- Backend: `GET /api/v1/sales-orders?status=&customerId=&cursor=`, `GET /api/v1/invoices?customerId=&status=&cursor=`.
- App: Auftrag erfassen (Kunde wählen, Produkte scannen/suchen, Mengen, Preisvorschau), bestätigen (Kreditlimit-Meldung; Inhaber: Übersteuern mit Begründung), Kommissionierung/Lieferung per Scan (Teillieferung), Rechnung erzeugen.
- Lieferschein und Rechnung anzeigen, drucken und teilen (`expo-print` erzeugt PDF aus dem HTML des Servers, `expo-sharing`).

Abnahmekriterien:
1. Test: doppelt gesendete Lieferung (gleiche `clientOpId`) bucht einmal – auch bei Netzabbruch in der App.
2. Test: Kreditlimit-Antwort (409 `CREDIT_LIMIT`) zeigt Betrag/Limit; Übersteuern nur für Inhaber sichtbar.
3. Gerätetest: PDF der Rechnung zeigt Arabisch korrekt verbunden.

## T-113 · Lager: Wareneingang, Inventur, Verlust
**Status:** offen · **Abhängig von:** T-110

- App: Wareneingang per Scan (Menge, MHD, Charge), Inventur (Zählliste je Regal, Differenzbuchung), Verlust mit Pflicht-Begründung – über `/sync/push`.
- MHD-/Mindestbestand-Warnungen aus `/stores/:id/stock-alerts` als Liste.

Abnahmekriterien:
1. Test: Inventurdifferenz bucht `inventory_count` mit Vorzeichen.
2. Test: Verlust ohne Begründung wird in der App verhindert (Server lehnt ohnehin ab).

## T-114 · Zahlungen und offene Posten
**Status:** offen · **Abhängig von:** T-111

- Backend: `POST /api/v1/customers/:id/payments` (bar, Scheck, Überweisung, Traite; Bezug auf Rechnung optional; Recht `payment.record`), `GET /customers/:id/statement` (Kontoauszug: Rechnungen, Gutschriften, Zahlungen, Saldo).
- App: Zahlung erfassen, Kontoauszug anzeigen/drucken.

Abnahmekriterien:
1. Test: Zahlung senkt Saldo; Zahlungen sind unveränderlich (Storno nur als Gegenbuchung).
2. Test: Kontoauszug-Summe = `customer_open_balance`.

## T-115 · Kasse (Abholverkauf)
**Status:** offen · **Abhängig von:** T-110

- Backend: Kassenverkauf auf `app.sales`/`sale_lines`/`payments` (fortlaufende Bonnummer je Kasse, idempotent über `client_op_id`, Lagerbuchung), Storno nur als Gegenbuchung mit Recht `sale.void`.
- App: Kassenbildschirm (Scan, Menge, Rabatt bis Kassierer-Limit, Bar/Karte, Rückgeld), Bon als HTML → Bondrucker (ESC/POS) folgt mit Hardware.

Abnahmekriterien:
1. Test: Bonnummern lückenlos je Kasse, auch bei gleichzeitigen Verkäufen.
2. Test: Rabatt über Limit nur mit Freigabe (`discount.approve`).

## T-116 · Benutzer, 2FA und Geräte in der App
**Status:** offen · **Abhängig von:** T-109

- App: Benutzer anlegen/ändern/deaktivieren (Regeln aus T-102/T-108), eigene 2FA einrichten (QR aus `otpauthUri`), Geräte des Mandanten anzeigen und sperren (`app.revoke_device`, Backend-Endpunkt ergänzen).

## T-117 · Gerätetest der App (Ahmed)
**Status:** offen · **parallel**

- Expo Go auf einem Android-Gerät, App aus `app/` mit `npx expo start` laden, Freischaltung gegen einen Test-Kundenserver, Anmeldung, Sprachwechsel ar/fr/en.
- Ergebnis (Fotos/Fehlermeldungen) an Claude; Befunde werden als Aufgaben erfasst.

## T-104 · Offline-Sync in der App
**Status:** offen · **Abhängig von:** T-109, T-113

- Lokale SQLite (verschlüsselt): Produkte, Barcodes, Bestand der eigenen Filiale, Sync-Queue.
- Buchungen offline erfassen (`client_op_id` = UUID v7), Push in Stapeln ≤ 500, Pull mit Cursor, WebSocket für Live-Updates.
- Abgelehnte Buchungen (`rejected`) sichtbar mit Grund.

Abnahmekriterien:
1. Test: 200 Buchungen offline, Verbindung wieder da → alle genau einmal auf dem Server (Idempotenz).
2. Test: zwei Geräte buchen offline auf dasselbe Produkt → Endbestand = Summe beider.

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
| 2026-11-03 | T-109 (PR #7) | erledigt (von Claude umgesetzt) | CI 21/21. Lizenzbanner bisher auf der Startseite; jeder neue Bildschirm (T-110 ff.) übernimmt ihn und graut im Nur-Lesen-Modus Schreibaktionen aus. |
| 2026-11-03 | T-110 (PR #8) | erledigt (von Claude umgesetzt) | CI fand: fremde Filiale lieferte für Mandant B eine Liste mit Bestand 0 → jetzt 404. Neu: gemeinsame Sitzung (`src/device/session.ts`), Lizenzbanner auf jeder Seite. Kamera nur auf echtem Gerät prüfbar (T-117). |
| 2026-11-03 | T-108 (PR #5) | erledigt (von Claude umgesetzt) | CI 18/18 grün. Lücke bei gemischten Filialen (RLS verbirgt fremde Zuordnungen) während der Umsetzung durch CI gefunden und behoben. |
| 2026-11-03 | T-105 (PR #6) | erledigt (von Claude umgesetzt) | CI 19/19 grün beim ersten Lauf. Dokumente als HTML statt PDF (Arabisch), begründet in PR. |
| 2026-11-03 | T-103 (PR #4) | erledigt (Befunde von Claude behoben) | CI 21/21 inkl. App-Typprüfung. Gerätetest offen (T-117). App-Plan T-109–T-117 angelegt. |
