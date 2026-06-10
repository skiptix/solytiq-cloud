# Solytiq Cloud - Security, Bug, Privacy & Compliance Audit Report

**Datum:** 2024-05-22
**Auditor:** Jules (AI Security Engineer)
**Commit SHA:** 0c709b39632eec5881e03831a9f7f07d09131b91
**Status:** Abgeschlossen

---

## 1. Executive Summary

Solytiq Cloud ist eine moderne Produktivitätsanwendung mit einem soliden Tech-Stack (React 19, Node 22, PG 16). Die Sicherheitsarchitektur umfasst JWT-Authentifizierung, TOTP 2FA und Rate Limiting. Der Review identifizierte jedoch mehrere kritische und hochgradige Schwachstellen, insbesondere im Bereich Access Control (IDOR), Insecure File Handling und Privacy by Default. Diese müssen vor einem produktiven Einsatz zwingend behoben werden.

---

## 2. Detaillierte Findings

### ID: FIND-01
**Titel:** Insecure Direct Object Reference (IDOR) in List Progress
**Schweregrad:** Mittel
**Betroffene Datei(en):** `backend/src/routes/lists.ts`
**Betroffene Route(n):** `GET /api/lists/:listId/progress`
**Betroffene Rolle(n):** Authentifizierter Benutzer
**Beschreibung:** Der Endpunkt zur Berechnung des Listen-Fortschritts validiert nicht, ob der anfragende Benutzer Zugriff auf die Liste hat.
**Technische Ursache:** Fehlende Autorisierungsprüfung in der SQL-Abfrage oder Middleware vor der rekursiven ID-Sammlung.
**Angriffsszenario:** Ein Angreifer errät oder extrahiert Listen-IDs (z.B. aus SSE-Events oder Logs) und fragt deren Fortschritt ab, um Metadaten über fremde Workspaces zu erhalten.
**Impact:** Informationsabfluss von Workspace-Metadaten und Aufgabenstatistiken.
**Reproduktionsschritte:** 1. Login als User A. 2. Request an `/api/lists/[ListID_User_B]/progress`.
**Proof of Concept:** `curl -H "Authorization: Bearer [UserA_JWT]" http://localhost/api/lists/[UserB_ListID]/progress` gibt JSON mit Metadaten zurück.
**Empfohlene Behebung:** Implementierung einer `checkListAccess` Middleware oder Integration der `user_id` in die rekursive SQL-Abfrage.
**Regressionstest:** Automatisierter Test, der 403/404 bei Zugriff auf fremde Listen-IDs erwartet.
**EU/Standard-Bezug:** OWASP ASVS 4.1.1, DSGVO Art. 32.
**Status:** Offen

### ID: FIND-02
**Titel:** Stored XSS via Insecure File Preview
**Schweregrad:** Hoch
**Betroffene Datei(en):** `backend/src/routes/files.ts`
**Betroffene Route(n):** `GET /api/files/:id/preview`
**Betroffene Rolle(n):** Authentifizierter Benutzer (Opfer), Beliebiger Benutzer (Angreifer)
**Beschreibung:** Dateien werden mit `Content-Disposition: inline` und benutzerdefiniertem MIME-Typ ausgeliefert.
**Technische Ursache:** Das Backend vertraut dem beim Upload angegebenen `mime_type` und erzwingt keinen Download für aktive Inhalte.
**Angriffsszenario:** Ein Angreifer lädt eine HTML-Datei mit Schadcode als `image/svg+xml` hoch. Wenn der Besitzer die Datei "vorschaut", wird der Code im Kontext der App-Domain ausgeführt.
**Impact:** Diebstahl von JWTs aus dem LocalStorage, Account-Übernahme.
**Reproduktionsschritte:** 1. Upload `exploit.html`. 2. Aufruf der Preview-URL im Browser.
**Proof of Concept:** `<script>alert(localStorage.getItem('solytiq_auth'))</script>` in einer als Bild getarnten Datei.
**Empfohlene Behebung:** `Content-Disposition: attachment` für alle Typen außer explizit sicheren Bildformaten (JPG, PNG).
**Regressionstest:** Prüfung des `Content-Disposition` Headers in der API-Antwort für diverse Dateitypen.
**EU/Standard-Bezug:** OWASP Top 10: Injection, ASVS 5.3.3.
**Status:** Offen

### ID: FIND-03
**Titel:** Fehlende Session-Invalidierung bei Passwortänderung
**Schweregrad:** Hoch
**Betroffene Datei(en):** `backend/src/routes/auth.ts`, `backend/src/auth.ts`
**Betroffene Route(n):** `PUT /api/auth/password`
**Betroffene Rolle(n):** Alle Benutzer
**Beschreibung:** Nach einer Passwortänderung bleiben alle zuvor ausgestellten JWTs bis zu ihrem natürlichen Ablauf (7 Tage) gültig.
**Technische Ursache:** JWTs sind stateless; es gibt keine serverseitige Prüfung einer Token-Version oder eines "Issued At" Zeitstempels gegen die Datenbank.
**Angriffsszenario:** Ein Angreifer stiehlt ein Token. Der Benutzer bemerkt den Zugriff und ändert sein Passwort. Der Angreifer behält dennoch für den Rest der Token-Laufzeit Zugriff.
**Impact:** Persistenter unbefugter Zugriff trotz Sicherheitsmaßnahme des Benutzers.
**Reproduktionsschritte:** 1. JWT generieren. 2. Passwort ändern. 3. Altes JWT für API-Request nutzen.
**Proof of Concept:** Request mit altem Token nach PW-Änderung liefert 200 OK.
**Empfohlene Behebung:** Einführung einer `token_version` in der `users` Tabelle, die bei PW-Änderung inkrementiert wird und im JWT enthalten ist.
**Regressionstest:** Testcase: Login -> PW-Change -> Verify old Token fails.
**EU/Standard-Bezug:** OWASP ASVS 2.8.1.
**Status:** Offen

### ID: FIND-04
**Titel:** Insecure First-User-Admin Registration
**Schweregrad:** Hoch
**Betroffene Datei(en):** `backend/src/routes/auth.ts`
**Betroffene Route(n):** `POST /api/auth/register`
**Betroffene Rolle(n):** Nicht authentifizierter Angreifer
**Beschreibung:** Die Anwendung erlaubt dem ersten registrierten Benutzer automatisch Admin-Rechte ohne weitere Verifikation.
**Technische Ursache:** Logik prüft nur `COUNT(*) FROM users`.
**Angriffsszenario:** Eine Instanz wird öffentlich gestartet (z.B. Cloud-Deployment). Ein Angreifer registriert sich vor dem eigentlichen Besitzer.
**Impact:** Vollständige Übernahme der Instanz und aller künftigen Daten.
**Reproduktionsschritte:** Aufruf von `/register` auf einer frischen Instanz.
**Proof of Concept:** Erster Benutzer erhält `is_admin: true`.
**Empfohlene Behebung:** Nutzung eines initialen Setup-Tokens, der via Umgebungsvariable oder Logfile bereitgestellt wird.
**Regressionstest:** Versuch der Registrierung ohne Setup-Token auf leerer DB.
**EU/Standard-Bezug:** CRA (Security by Default), OWASP ASVS 4.3.1.
**Status:** Offen

### ID: FIND-05
**Titel:** Verstoß gegen Privacy by Default (Öffentliche Ressourcen)
**Schweregrad:** Mittel
**Betroffene Datei(en):** `backend/src/routes/folders.ts`, `backend/src/routes/files.ts`
**Betroffene Route(n):** `POST /api/folders`, `POST /api/files`
**Betroffene Rolle(n):** Alle Benutzer
**Beschreibung:** Neue Ordner und Dateiuploads sind standardmäßig auf `is_public: true` gesetzt.
**Technische Ursache:** Hardcodierte Standardwerte in den SQL-Queries oder Route-Handlern.
**Angriffsszenario:** Ein Benutzer lädt sensible Daten hoch, im Glauben, diese seien privat. Ein Angreifer findet den Share-Link (z.B. via Brute-Force oder History) und greift unbefugt zu.
**Impact:** Unbeabsichtigte Datenpreisgabe.
**Reproduktionsschritte:** Erstellen eines Ordners ohne explizite Privacy-Angabe.
**Proof of Concept:** Datenbank-Eintrag zeigt `is_public = true`.
**Empfohlene Behebung:** Änderung der Standardwerte auf `false`.
**Regressionstest:** Überprüfung des `is_public` Status nach Erstellung ohne Parameter.
**EU/Standard-Bezug:** DSGVO Art. 25 (Datenschutz durch Voreinstellungen).
**Status:** Offen

---

## 3. Threat Model

*Siehe `threat-model.md` für die vollständige STRIDE-Analyse.*

---

## 4. Compliance & Standards Mapping

*Siehe `compliance-mapping.md` für Details zu OWASP, DSGVO, NIS2 und CRA.*

---

## 5. SBOM & Dependency Review

- **Kritisch:** `xlsx` Paket ist anfällig für Prototype Pollution.
- **Hoch:** `fast-xml-parser` anfällig für Injection.
- **Empfehlung:** Sofortiges Update aller Pakete und Ersatz von `xlsx` durch sicherere Bibliotheken wie `exceljs` oder isolierte Parser-Services.

---

## 6. Regressionstestplan

| Testfall | Methode | Erwartetes Ergebnis |
| :--- | :--- | :--- |
| **IDOR Check** | Automatisiert | Zugriff auf fremde Listen-Progress führt zu 403. |
| **XSS Check** | Manuell | HTML-Dateien führen nicht zu Script-Ausführung bei Preview. |
| **Session Check** | Automatisiert | Token-Invalidierung nach PW-Änderung greift sofort. |
| **Privacy Check** | DB-Audit | Neue Ressourcen sind standardmäßig `is_public = false`. |
| **Setup Lock** | Manuell | Nach Admin-Registrierung ist kein weiterer Admin ohne Einladung möglich. |
