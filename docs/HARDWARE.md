# Hardware beim Kunden

Stand: 06.11.2026. Preise in TND inkl. MwSt, recherchiert bei tunewtec, tunisianet, primini,
infotec und digital-cardtech. Die vollständige Kostentabelle mit Alternativen liegt als
`Hardware-Budget-Pilotkunde.xlsx` bei Ahmed.

## Grundausstattung Pilotkunde (Großhändler)

| Position | Empfehlung | Menge | Einzelpreis | Summe |
| --- | --- | ---: | ---: | ---: |
| Server | Mini-PC BMAX B6 Pro, i5-1030NG7, 16 GB, 512 GB NVMe | 1 | 1 079 | 1 079 |
| USV | NJOY Keen 1500 VA / 900 W, USB-Steuerung | 1 | 509 | 509 |
| Sicherung | Externe SSD ADATA SC740 1 TB USB-C | 2 | 285 | 570 |
| Switch | TP-Link TL-SG1008MP, 8 Ports Gigabit, PoE+ 126 W | 1 | 439 | 439 |
| WLAN | TP-Link EAP610 AX1800 Wi-Fi 6, PoE, Deckenmontage | 3 | 559 | 1 677 |
| 4G-Rückfall | D-Link DWR-M920 4G LTE N300 | 1 | 189 | 189 |
| Erfassung | Smartphone Samsung Galaxy A06, 6/128 GB | 3 | 499 | 1 497 |
| Scanner | Douchette A8 1D/2D QR, kabellos | 3 | 139 | 417 |
| A4-Druck | Brother HL-L2340DW, WLAN, Duplex | 1 | 289 | 289 |
| Kleinmaterial | Kabel, Kabelkanal, Montage | 1 | 150 | 150 |
| **Summe Pflicht** | | | | **6 816** |
| Kasse: Tablet | Samsung Galaxy Tab A9+ 11", 8/128 GB | 1 | 759 | 759 |
| Kasse: Bondrucker | Epson TM-T20X Ethernet, ESC/POS | 1 | 380 | 380 |
| Kasse: Schublade | RJ11, 8 Münz- und 4 Scheinfächer | 1 | 195 | 195 |
| Verbrauch | Thermorollen 80 mm, Ersatz-Toner | | | 160 |
| **Summe Optional** | | | | **1 494** |
| **Gesamt inkl. 10 % Reserve** | | | | **9 141** |

Handys von Inhaber und Geschäftsführer sind vorhanden und im Budget nicht enthalten.

## Warum Smartphone plus Scanner statt robustem Terminal

Ein Android-Terminal mit integriertem 2D-Scanner (DIGIPOS DP9000) kostet 2 570 TND. Smartphone
plus kabelloser Scanner kosten zusammen 638 TND. Bei drei Lagerplätzen sind das 1 914 statt
7 710 TND. Die App scannt bereits über die Handykamera (`app/src/ui/BarcodeScanner.tsx`), der
Hardware-Scanner macht es nur schneller. Für ein staubiges Kühllager oder Dauerbetrieb über
Jahre bleibt das robuste Terminal die bessere Wahl.

## Was die App noch braucht

| Gerät | Offener Punkt |
| --- | --- |
| Kabelloser Scanner | Keyboard-Wedge-Modus (HID): die Eingabe kommt als Tastaturanschlag. Das Eingabefeld der Scan-Masken muss den Zeilenumbruch am Ende als „Code vollständig“ behandeln, statt auf die Kamera zu warten. |
| Bondrucker im Netzwerk | ESC/POS über TCP auf Port 9100 statt `expo-print`. Der Bonbeleg liegt heute als HTML vor (`backend/src/core/receipt-document.ts`) und braucht einen zweiten Renderer für 80-mm-ESC/POS. |
| Kassenschublade | Öffnet über den DK-Anschluss des Bondruckers, nicht über das Tablet. Das Öffnen ist ein ESC/POS-Befehl und hängt damit am Punkt oben. |
| USV | Der Server muss bei leerem Akku selbst herunterfahren, sonst nimmt die Datenbank Schaden. Gehört in den Installer (`nut` oder `apcupsd`). |

## Direktimport aus China (geprüft 10.11.2026)

Der Anbieter sitzt in Deutschland, der Kunde in Tunesien. Geprüft wurde, ob sich die Hardware
komplett ab Werk in China kaufen lässt. Ergebnis: nur bei einer Position lohnt es sich.

| Position | Landed HT | Lokal HT | Differenz je Stück |
| --- | ---: | ---: | ---: |
| Robustes Android-PDA 1D/2D (FOB 125 USD) | 461 | 2 160 | **+1 698** |
| Bondrucker 80 mm mit LAN (FOB 25 USD) | 144 | 319 | +175 |
| Scanner 2D kabellos (FOB 20 USD) | 81 | 117 | +36 |
| Scanner 2D mit USB-Kabel (FOB 25 USD) | 99 | 83 | −16 |
| Kassenschublade RJ11 (FOB 20 USD) | 223 | 164 | −59 |

Gerechnet mit USD 2,98, Luftfracht 25 TND/kg, Zoll 20 % als Platzhalter, RPD 3 %. Die TVA ist
beidseitig abziehbar und deshalb ausgeklammert. Rechner: `Hardware-Budget-Pilotkunde.xlsx`,
Blatt „Import Alibaba".

Drei Gründe, warum der Rest lokal gekauft wird:

1. **Der Umweg über Deutschland spart keinen tunesischen Zoll.** Das Assoziierungsabkommen
   EU-Tunesien befreit nur Waren mit EU-Ursprung. Ware aus China behält chinesischen Ursprung,
   auch wenn sie in Deutschland umgeladen wird; Software aufspielen ist keine ausreichende
   Be- oder Verarbeitung. Ohne EUR.1 gilt der normale Zollsatz.
2. **Funkgeräte brauchen Homologation (ANF/CERT)** je Typ, Marke und Modell, auf den Namen des
   Importeurs, mit Vertretung in Tunesien und einem Mustergerät. 6 bis 8 Wochen, über ein
   bestehendes Zertifikat 10 bis 15 Tage. Keine Ausnahme für Kleinmengen. Betrifft PDA,
   Access Points, 4G-Router, Tablet, Smartphones und kabellose Scanner.
3. **Tunesische Händler importieren dieselbe China-Ware in Mengen.** Bei Scannern und
   Kassenschubladen ist ihre Marge kleiner als unsere Fracht.

Konsequenz für die Serie: ein PDA-Modell aussuchen, einmal homologieren, dann für alle Kunden
nachkaufen. Nicht je Kunde ein anderes Modell.

### Anpassen ohne OEM

Logo und eigener Startbildschirm vom Hersteller setzen 100 bis 500 Stück voraus. Dafür gibt es
keinen Grund: Android Enterprise im Device-Owner-Modus wird per QR-Code aufgesetzt, installiert
die App, sperrt Play Store und Einstellungen und startet direkt in den Kiosk-Modus. Das
funktioniert auf jedem Android-Gerät, auch dem Samsung A06 für 379 TND. Server vorinstallieren
und Geräte beschriften passiert in Deutschland, der Kunde packt nur aus.

### Offen vor der ersten Bestellung

- Echte Zollsätze je Zolltarifnummer aus dem Tarif Web 2026 der tunesischen Zollverwaltung oder
  vom Transitär. Die 20 % in der Tabelle sind ein Platzhalter.
- Einführerpflichten der deutschen Firma: CE-Konformität, technische Unterlagen, RoHS, und je
  nach Fall WEEE-, Batterie- und Verpackungsregistrierung. Ob sie beim sofortigen Weiterversand
  nach Tunesien entstehen, klärt der Steuerberater.
- Für jedes importierte Modell ein Ersatzgerät mitkaufen. Bei Direktimport gibt es keine lokale
  Rücknahme.

## Nicht im Budget

Internetanschluss und SIM-Datenpaket, Lizenzmiete, Installation und Einweisung,
Etikettendrucker (erst wenn die Etikettenfunktion gebaut ist), Kartenterminal (hängt an der
Bank des Kunden), zweiter Server als Ausfallreserve.

## Verfügbarkeit am 06.11.2026

Brother HL-L2340DW und Kassenschublade TR-410 waren bei tunisianet als *hors stock* gelistet.
DIGIPOS DP9000 und D-Link DWR-M920 hatten bei primini einen Listenpreis, aber kein aktives
Händlerangebot. Preise vor dem Kauf beim Händler bestätigen.
