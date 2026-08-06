# Claude-Code-Prompt: Security- und Migrationsfundament

Du arbeitest im Repository `solytiq-cloud`. Führe diesen Auftrag autonom, aber in kleinen, überprüfbaren Sprints aus. Ändere nur Dateien, die für die hier genannten Sicherheits- und Migrationsziele erforderlich sind. Committe und pushe nicht, sofern der Nutzer das nicht separat verlangt.

## Outcome

Schaffe ein produktionsfähiges Sicherheits- und Migrationsfundament:

- bestätigte XSS-, Cross-Tenant-, OAuth-, SSRF-, URL-Secret-, Upload-, Rate-Limit- und Passwortlücken sind geschlossen;
- Authentifizierung und Autorisierung verwenden zentrale, konsistente Policies;
- Privacy Defaults und Schema sind auf Neuinstallationen und Upgrades identisch;
- Migrationen sind versioniert, prüfbar, crash-sicher und gegen parallele Ausführung geschützt;
- relevante Parser- und Upload-Abhängigkeiten besitzen keine bekannten erreichbaren High-Severity-Lücken;
- Regressionstests beweisen die Schutzwirkung, statt sie nur zu behaupten.

## Ground Truth

Der aktuelle Checkout, seine Tests, Lockfiles und das beobachtbare Laufzeitverhalten sind die Wahrheit. `CLAUDE.md`, `README*`, `security_report.md`, der bereitgestellte Architektur-Audit und darin genannte Zeilennummern sind nur Hinweise, die du gegen den aktuellen Code prüfen musst. Übernimm keine Aussage ungeprüft. Der Prompt ist selbstständig ausführbar und darf nicht von einem externen absoluten Audit-Dateipfad abhängen.

Audit-Anker war Commit `9e538425dd48172cea94e21878c4ff97820dad80`. Wenn der aktuelle Commit abweicht, untersuche den aktuellen Stand und passe den Plan an. Dokumentation darf niemals Code, Tests oder Datenbankinvarianten überstimmen. Bei Widersprüchen benenne die Evidenz im Handoff.

## Scope

1. OSM-/Leaflet-Popup-XSS, sichere URL-Behandlung und CSP/Security-Header.
2. Zentrale Tenant-/Objektpolicy für Tasks, Listen, Task- und Milestone-Anhänge, Canvas, Sync und Downloads.
3. Private Folder-Defaults in allen Schema- und Create-Pfaden.
4. OAuth Dynamic Client Registration, Consent, Scope/Audience, PAT-TTL und Rotation.
5. JWTs und Share-Passwörter aus SSE-, Markdown-, Knowledge-Base- und Share-URLs entfernen; vollständige Session-Revocation.
6. Redirect-SSRF und ungebremstes Response-Buffering des Automation-HTTP-Nodes.
7. Vertrauensgrenze für Proxy-IP und Rate-Limits; mehrinstanzfähiger Limit-Store nur als schmale Abstraktion vorbereiten, nicht die gesamte Skalierungsarchitektur bauen.
8. Einheitliche Passwort-/JWT-Secret-Policy, Step-up für 2FA-Sicherheitsänderungen und verschlüsselte TOTP-Secrets.
9. Upload- und Bundle-Limits, atomare Quotenreservierung, Cleanup und sichere Parser-Abhängigkeiten.
10. Versionierte Migrationen mit Historie, Checksums, Lock und erwarteter Schema-Version.
11. Sicherheitsbezogene Tests und CI-Gates für die geänderten Pfade.

Prüfe insbesondere die aktuellen Entsprechungen der Audit-Hinweise M1 bis M12. Suche selbst nach allen Call-Sites und Parallelpfaden.

## Non-goals

- Kein UI-Redesign und keine neue Komponentenbibliothek.
- Keine allgemeine Frontend-Lint-Bereinigung.
- Keine vollständige Worker-, Pagination-, Object-Storage-, Observability- oder Multi-Replica-Architektur; das folgt separat.
- Keine Änderung fachlicher Produktfunktionen außerhalb notwendiger Security-Kompatibilität.
- Keine pauschale ORM-Einführung und kein Rewrite des Backends.
- Keine destruktive Schema- oder Datenbereinigung ohne beweisbaren, reversiblen Backfill.

## Invarianten

- Unberechtigte und nicht existierende private Objekte bleiben nach außen ununterscheidbar, vorzugsweise `404` statt Existenz-Leak.
- Autorität stammt ausschließlich aus verifizierter Identität, aktuellem Benutzerzustand, `token_version`, Connection-Status und serverseitiger Policy.
- Kein lang gültiges Secret erscheint in URL, Browserhistorie, Referrer oder Standard-Access-Log.
- OAuth-Scopes und Audience werden gespeichert und bei jedem Einsatz erzwungen.
- Private Workspaces bleiben privat, auch wenn ein Child-Objekt in-app sichtbar markiert ist.
- Uploadgrenzen gelten vor oder während des Streams; ein Fehler hinterlässt weder Bytes noch Metadaten.
- Migrationen sind append-only. Bereits angewandte Migrationen werden nicht nachträglich verändert.
- Raw SQL bleibt parametrisiert. Dynamische Identifier stammen nur aus festen Allowlist-Maps.
- Vorhandene Schutzmaßnahmen wie bcrypt Cost 12, PKCE-S256, zufällige Dateinamen, `path.basename`, MIME-Allowlist und `isolated-vm` dürfen nicht geschwächt werden.
- Mobile-, MCP-, CalDAV-, Admin-API- und öffentliche Share-Flows müssen explizit auf Regressionen geprüft werden.

## Preflight

Führe zuerst read-only aus:

```bash
pwd
git rev-parse HEAD
git status --short
rg --files -g 'AGENTS.md' -g 'CLAUDE.md' -g 'README*' -g 'package*.json' -g '*lock*'
```

Lies anschließend die relevanten Implementierungen und Tests. Verwende `rg` für Auth-, Policy-, Query-Token-, Upload-, Redirect-, Proxy- und Migrationspfade. Erzeuge eine knappe Evidenzmatrix: bestätigt, bereits behoben oder nicht reproduzierbar. Implementiere nur bestätigte aktuelle Lücken.

Ermittle einen Baseline-Commit und sichere ihn nur als Shellvariable für Diff-Prüfungen:

```bash
BASE_COMMIT="$(git rev-parse HEAD)"
```

## Arbeitszyklus für jeden Sprint

Für jeden Sprint gilt strikt:

1. **Explore:** Datenfluss, Call-Sites, Tests und Invarianten read-only nachvollziehen.
2. **Plan:** kleinsten vollständigen Fix, Rückwärtskompatibilität, Testfälle und Rollback beschreiben.
3. **Implement:** nur diesen Sprint ändern; keine kosmetischen Nachbaränderungen.
4. **Verify:** gezielte Regressionstests, danach Build und relevante Gesamttests ausführen.
5. **Frischer Review:** einen frischen Subagenten nur den Diff gegen Scope, Invarianten und Angriffsszenario prüfen lassen. Er soll belegbare Korrektheitslücken melden, keine Stilpräferenzen. Behebe bestätigte Findings und verifiziere erneut.

Beginne den nächsten Sprint erst, wenn der aktuelle Sprint grün ist oder ein eindeutig vorbestehender Fehler mit Vorher-/Nachher-Evidenz unverändert bleibt.

## Sprint Contracts und Reihenfolge

### S1: Browser-Grenze

- Leaflet-Popups ohne HTML-String-Interpolation aus untrusted Daten bauen; Text über DOM/React sicher setzen.
- Linkprotokolle allowlisten und XSS-Payloads testen.
- CSP und Header am richtigen App-/Edge-Level ergänzen, ohne Karten-, API- oder notwendige Asset-Flows pauschal zu brechen.
- Akzeptanz: Payloads in Name, Adresse, Tag und Website werden sichtbar als Text oder verworfen; kein Event-Handler läuft.

### S2: Zentrale Objekt- und Tenant-Policy

- Bestehende korrekte Listen-/Workspace-Policy als Ausgangspunkt prüfen und eine wiederverwendbare Policy-/Query-Schicht schaffen.
- Tasks, Sync-Bootstrap/-Delta, Canvas-Direktzugriff und beide Attachment-Typen darauf umstellen.
- Negative Tests mit zwei Nutzern und zwei privaten Workspaces ergänzen.
- Folder-Default in kanonischem Schema, Migration und allen Create-Pfaden explizit privat setzen.
- Akzeptanz: Kein Child-Endpunkt liefert Metadaten, IDs oder Bytes, die der zugehörige Parent-Zugriff verbietet.

### S3: Auth-, OAuth- und Secret-Lebenszyklus

- DCR authentisieren oder streng allowlisten; Consent zeigt echten Client und exakte Redirect-Domain.
- OAuth-Scopes/Audience allowlisten, persistieren und für PAT/MCP durchsetzen; kurze TTL und sichere Rotation.
- Eine Passwortpolicy für Setup, Admin-Create/-Reset und Self-Service; begrenzte Maximallänge vor bcrypt.
- JWT-Secrets auf Mindestlänge, Entropie und bekannte Platzhalter prüfen.
- TOTP-Secrets mit einem Schlüssel außerhalb der DB verschlüsseln; Setup/Disable verlangt frischen Step-up. Bestehende Secrets migrationsfähig behandeln.
- Akzeptanz: Täuschender Client, nicht erlaubter Scope, abgelaufenes Token, Ein-Zeichen-Passwort und gestohlene Session ohne Step-up werden abgewiesen.

### S4: Keine Secrets in URLs

- SSE und geschützte Assets über HttpOnly-Session oder kurzlebige, opake, eng gebundene Einmal-Tickets authentisieren.
- Zentral dieselben Revocation-Prüfungen wie normale API-Requests verwenden; offene SSE-Verbindungen nach Sicherheitsänderungen schließen und begrenzen.
- Knowledge-Base-Bild-401 beheben, ohne Query-JWT global zu erlauben.
- Share-Passwort per POST gegen kurzlebige Share-Session tauschen; Access-Logs redigieren.
- Akzeptanz: `rg` findet keinen produktiven Langzeit-JWT- oder Klartext-Share-Passwortbau in URLs; Revocation-Test schließt bzw. invalidiert die Verbindung.

### S5: SSRF, Proxy und Rate-Limits

- HTTP-Node auf manuelle, begrenzte Redirects umstellen und jedes Ziel einschließlich aller DNS-Adressen neu prüfen; Response streamen und beim Byte-Limit abbrechen.
- Proxy-Vertrauen auf konfigurierte Netze/Hops begrenzen. Untrusted `CF-Connecting-IP` entfernen oder am Edge sicher normalisieren.
- Login nach Account und IP begrenzen; MCP erhält Token-/IP- und Concurrency-Limits.
- Akzeptanz: Public-zu-Private-Redirect, Metadaten-IP, DNS-Wechsel, großer Stream und gespoofter Proxy-Header werden reproduzierbar blockiert.

### S6: Uploads und Supply Chain

- Harte Edge-, Request-, Datei-, Part-, Anzahl- und Bundle-Limits zentral konfigurieren.
- Quoten vor/während des Streams atomar reservieren und alle Uploadklassen einrechnen. Bundle-Metadaten transaktional schreiben; Fehler räumen Datei und DB-Zeilen auf.
- `multer`, `adm-zip` und `xlsx` anhand aktueller Lockfile/Advisories prüfen. Sichere Version einsetzen oder verwundbaren Parser ersetzen bzw. isolieren.
- Akzeptanz: parallele Uploads überschreiten die Quote nicht; Abbruch, Oversize und fehlerhaftes Bundle hinterlassen nichts; Runtime-Audit enthält keine ungeklärte erreichbare High-Lücke in diesen Pfaden.

### S7: Versionierte Migrationen

- Startup-Monolith untersuchen und ein append-only Migrationssystem mit ID, Checksum, Status und erwarteter Schema-Version einführen.
- Migrationen einmal pro Deployment oder unter PostgreSQL Advisory Lock ausführen; geeignete DDL-/Backfill-Schritte transaktional machen.
- Bestehende Installation übernehmen, ohne alle historischen Statements erneut auszuführen. Fresh Install und Upgrade müssen dasselbe Schema erzeugen.
- Readiness bleibt rot, wenn Schema-Version oder fehlgeschlagene Migration nicht stimmt.
- Akzeptanz: zwei parallel gestartete Migratoren führen jede Migration genau einmal aus; ein simulierter Abbruch ist sicher fortsetzbar; geänderte Checksum stoppt den Start.

## Stop-Bedingungen

Stoppe und frage konkret nach, wenn:

- der Worktree fremde Änderungen in Dateien enthält, die du ändern müsstest;
- eine notwendige Auth-/API-Änderung Mobile, CalDAV, MCP oder einen externen Client inkompatibel machen würde und keine additive Migration möglich ist;
- ein Daten-Backfill nicht eindeutig aus vorhandenen Daten ableitbar oder nicht reversibel ist;
- produktive Proxy-, TLS-, KMS- oder Storage-Annahmen nicht aus Code/Konfiguration belegbar sind;
- ein Dependency-Fix nur über eine unklare Lizenz, private Registry oder unmaintained Fork möglich wäre;
- Tests eine zuvor unbekannte Cross-Tenant- oder Datenverlustlücke außerhalb des Scopes zeigen.

Unterdrücke keine Fehler mit `any`, `eslint-disable`, pauschalen `try/catch`, deaktivierten Tests, schwächeren Assertions oder Fail-open-Verhalten.

## Exakte Abschlussverifikation

Führe mindestens aus:

```bash
(cd backend && npm run build)
(cd backend && TEST_UPLOAD_DIR="$(mktemp -d)" && TZ=UTC UPLOAD_DIR="$TEST_UPLOAD_DIR" npm test)
(cd backend && npm audit --omit=dev)
(cd frontend && npm test)
(cd frontend && npm run build)
(cd frontend && npm audit --omit=dev)
docker compose config --quiet
git diff --check
git status --short
```

Führe zusätzlich alle neuen Postgres-Integrations-, Cross-Tenant-, OAuth-, SSE-, SSRF-, Upload- und Migrations-Concurrency-Tests mit den im Projekt ergänzten exakten Scripts aus. Für das bereits bekannte Frontend-Lint-Defizit gilt: keine neuen Fehler in geänderten Dateien; führe ESLint gezielt auf allen geänderten Frontend-TS/TSX-Dateien aus. Verändere keine unbeteiligten Dateien nur zur Baseline-Bereinigung.

## Messbare Gesamtabnahme

- Alle neuen Angriffstests schlagen vor dem Fix fehl und nach dem Fix zuverlässig an der richtigen Schutzgrenze fehl.
- Zwei-Tenant-Matrix für List, Task, Canvas, Sync und Attachments ist vollständig negativ.
- Keine lang gültigen JWTs oder Share-Passwörter in URLs oder Standard-Access-Logs.
- OAuth-Tokens besitzen TTL, Audience und erzwungene Scopes; DCR und Consent können keinen fremden Client als „Claude“ ausgeben.
- Jeder Uploadpfad hat zentrale Limits, atomare Quote und vollständiges Cleanup.
- Fresh Install und Upgrade enden bei identischer erwarteter Schema-Version; parallele Migratoren und Crash-Recovery sind getestet.
- Backend-/Frontend-Builds und Tests sind grün; geänderte Frontend-Dateien sind lint-fehlerfrei.
- Der finale Diff enthält keine fachfremden Änderungen und keine neuen ungeprüften Runtime-Abhängigkeiten.

## Handoff

Berichte am Ende knapp und beweisorientiert:

1. Outcome pro Sprint und geänderte Schutzgrenze.
2. Geänderte Dateien und Migrationen.
3. Neue Regressionstests mit jeweils verhindertem Angriff.
4. Exakte ausgeführte Befehle und Ergebnisse.
5. Abweichungen vom Audit aufgrund aktuellen Codes.
6. Verbleibende Risiken, Rollout-/Backfill-Schritte und sichere Rollback-Option.
7. `git diff --stat` und Hinweis, dass weder Commit noch Push erfolgt ist.
