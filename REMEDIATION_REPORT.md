# Solytiq Cloud - Remediation Report

**Datum:** 2024-05-22
**Commit SHA vor Fix:** 0c709b39632eec5881e03831a9f7f07d09131b91
**Commit SHA nach Fix:** [Aktueller Commit SHA]

## 1. Status der behobenen Findings

| ID | Finding | Status | Behebung |
| :--- | :--- | :--- | :--- |
| FIND-01 | IDOR in List Progress | Fixed | Autorisierungsprüfung in `backend/src/routes/lists.ts` hinzugefügt. |
| FIND-02 | Stored XSS via File Preview | Fixed | Whitelist für MIME-Typen und `Content-Disposition: attachment` erzwungen. |
| FIND-03 | Session Invalidation | Fixed | `token_version` Mechanismus in DB und JWT implementiert. |
| FIND-04 | First User Admin Setup | Fixed | `INITIAL_SETUP_TOKEN` Pflicht für die Erstregistrierung eingeführt. |
| FIND-05 | Privacy by Default | Fixed | Standardwerte für Ordner und Dateien auf `is_public = false` geändert. |
| SBOM-01 | xlsx Risiko | Mitigated | Parser-Nutzung bleibt auf Auth-Sessions beschränkt. Update auf 0.18.5. |
| SBOM-02 | fast-xml-parser Risiko | Fixed | Update auf Version 5.0.0 (behebt Injection-Risiken). |

## 2. Details pro Finding

### FIND-01: IDOR in List Progress
- **Betroffene Dateien:** `backend/src/routes/lists.ts`
- **Fix:** Vor der Progress-Berechnung wird nun geprüft, ob der anfragende User Besitzer der Liste ist, Mitglied im Workspace der Liste ist, oder ob die Liste öffentlich ist.
- **Test:** Manueller Versuch mit fremder ListID liefert 403 Forbidden.

### FIND-02: Stored XSS via File Preview
- **Betroffene Dateien:** `backend/src/routes/files.ts`, `backend/src/index.ts`
- **Fix:** Whitelist für sichere Inline-Typen (`image/png`, `image/jpeg`, `image/webp`, `image/gif`, `text/plain`). Alle anderen werden als Download (`attachment`) mit anonymisiertem MIME-Typ ausgeliefert. CSP Sandbox Header hinzugefügt.
- **Test:** HTML/SVG Uploads werden nun zum Download angeboten statt im Browser gerendert.

### FIND-03: Fehlende Session-Invalidierung
- **Betroffene Dateien:** `backend/src/auth.ts`, `backend/src/middleware.ts`, `backend/src/routes/auth.ts`, `backend/src/routes/admin.ts`
- **Fix:** `token_version` Feld in `users` Tabelle. JWT enthält diese Version. Middleware vergleicht JWT-Version mit DB-Version. Inkrementierung bei Passwortänderung (User/Admin) und 2FA-Statusänderung.
- **Test:** Nach Passwortänderung wird ein altes JWT sofort mit 401 rejected.

### FIND-04: Insecure First-User-Admin Registration
- **Betroffene Dateien:** `backend/src/routes/auth.ts`, `frontend/src/screens/SetupWizard.tsx`, `frontend/src/api/client.ts`
- **Fix:** Backend prüft `INITIAL_SETUP_TOKEN` aus der Env-Variable bei der Registrierung des allerersten Nutzers. Frontend führt einen neuen Wizard-Schritt zur Token-Eingabe ein.
- **Test:** Registrierung auf leerer DB schlägt ohne korrektes Setup-Token fehl.

### FIND-05: Privacy by Default
- **Betroffene Dateien:** `backend/src/routes/folders.ts`, `backend/src/routes/files.ts`, `backend/src/index.ts`
- **Fix:** SQL-Schemas und Route-Handler auf `is_public: false` als Standard umgestellt.
- **Test:** Neue Ordner und Dateien werden ohne Parameter als "privat" in der DB angelegt.

## 3. Build & Test Ergebnisse
- **npm run build (Backend):** Erfolgreich
- **npm run build (Frontend):** Erfolgreich
- **npm audit (Backend):** 0 kritisch, 1 high (xlsx - acknowledged)
- **npm audit (Frontend):** 0 vulnerabilities

## 4. Visuelle Regression
Es wurden keine UI-Änderungen vorgenommen, außer dem zwingend erforderlichen Feld für das Setup-Token im initialen Setup-Wizard. Alle anderen Screens (Dashboard, Listen, Einstellungen) bleiben visuell identisch.
