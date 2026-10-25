# HelferFix MVP – Konten, Rollen, Adminbereich und Fahrtanfragen

Dieses Projekt ist ein **lokal ausführbarer MVP mit installierbarer PWA-Oberfläche**, kein öffentlich gehosteter Dienst. Auf Android kann es über Chrome installiert und auf dem Startbildschirm geöffnet werden; dafür muss es online über HTTPS laufen (localhost ist für Entwicklung ebenfalls erlaubt). Es enthält:

- Registrierung als Kunde oder Fahrer; öffentliche Registrierung kann niemals Admin-Rechte vergeben.
- Passwort-Hashes mit bcryptjs und serverseitige Sessions in SQLite.
- Rollenprüfungen auf den API-Endpunkten (`admin`, `customer`, `driver`).
- Admin-Dashboard: Nutzerübersicht, Nutzer aktivieren/deaktivieren, Fahrtstatus verwalten und einfache Plattform-Einstellungen pflegen.
- Kunden können eine Fahrt anfragen (Voreinstellungen: Merseburg → Flughafen Leipzig/Halle, 2 Personen, 2 Gepäckstücke, PKW) und Angebote ansehen/annehmen.
- Fahrer können offene Anfragen ansehen und Preisangebote abgeben.
- SQLite-Datenbank für Konten, Fahrtanfragen, Angebote, Einstellungen und Sessions.
- PWA-Manifest, Service Worker und 192/512-Pixel-App-Symbole; statische Oberfläche kann teilweise offline zwischengespeichert werden. API-Daten und Buchungen werden bewusst nicht offline gecacht.

## Voraussetzungen

- Node.js 20 oder neuer
- npm

## Start lokal

1. Entpacke den ZIP-Ordner.
2. Terminal/PowerShell im Projektordner öffnen.
3. Installiere Abhängigkeiten:

   ```bash
   npm install
   ```

4. Kopiere `.env.example` nach `.env`.
5. Ändere `SESSION_SECRET`, `ADMIN_EMAIL` und `ADMIN_PASSWORD` in `.env` in Werte nur du kennst. Das Admin-Konto wird beim ersten Start automatisch erstellt, wenn kein Admin in der Datenbank existiert.
6. Starte:

   ```bash
   npm start
   ```

7. Öffne `http://localhost:3000`.

Die SQLite-Datenbank wird automatisch im Ordner `data/helferfix.sqlite` angelegt. Bewahre `.env` und den Ordner `data` sicher auf; teile die Admin-Zugangsdaten niemals.

## Auf Android installieren

1. Die Anwendung auf einem HTTPS-fähigen Hosting bereitstellen (oder lokal auf `http://localhost:3000` testen).
2. Die Seite in Chrome auf Android öffnen.
3. Im Browser-Menü „App installieren“ oder „Zum Startbildschirm hinzufügen“ auswählen. Auf unterstützten Browsern erscheint auch die Schaltfläche „App installieren“.
4. Die PWA startet danach in einem app-ähnlichen Fenster. Das ist noch keine APK und keine Veröffentlichung im Google Play Store.

## Wichtige Grenzen vor Livebetrieb

Dieser MVP ist ein Ausgangspunkt für Entwicklung und Tests. Vor einer Veröffentlichung im Internet sind mindestens nötig:

- Hosting mit HTTPS und `COOKIE_SECURE=1`, starkes zufälliges `SESSION_SECRET`, Backups und Monitoring.
- CSRF-Schutz (z. B. synchronizer token), strenge Content Security Policy, Prüfung der Eingaben und Tests der Zugriffskontrollen.
- Passwort-Zurücksetzen, E-Mail-Verifizierung, Protokollierung sicherheitsrelevanter Admin-Aktionen, Datenschutz- und Löschkonzept.
- Prüfung/Verifizierung von Fahreridentität, Gewerbe, Personenbeförderungsrecht, Versicherungen und lokalen Anforderungen in Deutschland.
- Zahlungsanbieter nur über sichere Integration; in diesem MVP gibt es keine Zahlungen, Auszahlung, echte Fahrer-Verfügbarkeit, Benachrichtigungen oder rechtlich verbindliche Fahrtenbuchung.
- Der Knopf zum Annehmen eines Angebots ändert den Status im Prototyp, stellt aber keine Garantie dar, dass Fahrt oder Fahrerlaubnis extern geprüft wurden.

## Rollenmodell

- `admin`: wird nur über die Umgebungsvariablen beim ersten Setup angelegt; kann Nutzer, Anfragen und Plattformeinstellungen verwalten.
- `customer`: erstellt eigene Fahrtanfragen und sieht deren Angebote.
- `driver`: sieht offene Anfragen und legt Angebote an.

Nicht zulässig: Admin-Rolle aus dem öffentlichen Registrierungsformular vergeben.
