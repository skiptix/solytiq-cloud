# Compliance & Standards Mapping

## 1. DSGVO (GDPR)
- **Privacy by Design:** Mehrere Bereiche identifiziert, in denen Datenschutz nicht die Standardeinstellung ist (z. B. Ordner/Dateien standardmäßig öffentlich).
- **Datenminimierung:** KI-Funktionen senden Daten an Drittanbieter (OpenRouter) ohne PII-Filterung oder explizite Einwilligung pro Anfrage.
- **Recht auf Löschung:** "Nuke"-Funktion vorhanden, aber Revisionssicherheit muss geprüft werden. Soft-Delete Papierkorb läuft nach 30 Tagen ab.
- **Technische & Organisatorische Maßnahmen (TOMs):** Schwachstellen in der Sitzungsverwaltung und Infrastruktur-Härtung identifiziert.

## 2. OWASP ASVS (v4.0.3)
- **V2: Authentifizierungsprüfung:**
  - 2.1.1: Passwortkomplexität wird nicht erzwungen.
  - 2.8.1: Keine Sitzungsinvalidierung bei Passwortänderung.
- **V3: Sitzungsverwaltungsprüfung:**
  - 3.1.1: JWT im LocalStorage gespeichert (XSS-Risiko).
- **V4: Zugriffskontrollprüfung:**
  - 4.1.1: IDOR in `/api/lists/:listId/progress`.
- **V5: Validierung, Bereinigung und Kodierung:**
  - 5.3.3: Potenzielles XSS über Dateivorschau.
- **V12: Dateiupload:**
  - 12.1.1: Vertrauen auf clientseitig bereitgestellte MIME-Typen.
  - 12.5.1: Fehlendes Malware-Scanning für Uploads.

## 3. NIS2 & Cyber Resilience Act (CRA)
- **Security by Design:** Fehlende robuste CSP und gehärtete Header.
- **Schwachstellenmanagement:** Abhängigkeit von mehreren Parser-Bibliotheken (`xlsx`, `fast-xml-parser`) mit potenziellen CVEs.
- **Incident Response:** Fehlende Audit-Logs für administrative Aktionen.
- **Zugriffskontrolle:** "First User Admin"-Logik ist ein kritischer Fehlerpunkt bei öffentlicher Exposition vor dem Setup.
