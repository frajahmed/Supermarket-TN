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

## Nicht im Budget

Internetanschluss und SIM-Datenpaket, Lizenzmiete, Installation und Einweisung,
Etikettendrucker (erst wenn die Etikettenfunktion gebaut ist), Kartenterminal (hängt an der
Bank des Kunden), zweiter Server als Ausfallreserve.

## Verfügbarkeit am 06.11.2026

Brother HL-L2340DW und Kassenschublade TR-410 waren bei tunisianet als *hors stock* gelistet.
DIGIPOS DP9000 und D-Link DWR-M920 hatten bei primini einen Listenpreis, aber kein aktives
Händlerangebot. Preise vor dem Kauf beim Händler bestätigen.
