# Claude-Code-Prompt: Backend Reliability, Performance und Skalierbarkeit

Du arbeitest im Repository `solytiq-cloud`. Setze diesen Auftrag autonom in kleinen, messbaren Sprints um. Ändere nur Backend-, Datenbank-, Infrastruktur-, Test- und unmittelbar notwendige API-Vertragsdateien. Committe und pushe nicht, sofern der Nutzer das nicht separat verlangt.

## Outcome

Entwickle das bestehende Single-Host-Backend zu einer belastbaren, horizontal skalierbaren Grundlage:

- Uploadbytes sind von API-Prozessen entkoppelt, Quoten und Bundles sind atomar;
- Scheduler und Worker verwenden Leases, Idempotenz, Retry und Crash-Recovery;
- Concurrency- und Reorder-Mutationen sind atomar;
- große APIs und Sync-Pfade sind paginiert, granular und serverseitig begrenzt;
- Hot Queries besitzen durch Messung belegte Indizes;
- SSE, Jobs, DB-Pool und Shutdown haben harte Ressourcenbudgets;
- Readiness bildet reale Abhängigkeiten ab;
- Container sind minimal privilegiert und reproduzierbar;
- strukturierte Telemetrie und echte PostgreSQL-/Multi-Worker-Integrationstests beweisen den Betrieb.

## Ground Truth und Abhängigkeit

Der aktuelle Checkout, Lockfiles, Tests, SQL und beobachtbares Verhalten sind die Wahrheit. `CLAUDE.md`, `README*`, der bereitgestellte Architektur-Audit und alte Zeilennummern sind nur zu prüfende Hinweise. Dieser Prompt ist selbstständig ausführbar und darf nicht von einem externen absoluten Audit-Dateipfad abhängen.

Dieser Part baut auf `refactor/01-security-and-migration-foundation.prompt.md` auf. Prüfe zuerst, ob zentrale Security-Policies, Uploadgrenzen/Quotenreservierung und versionierte Migrationen im aktuellen Code tatsächlich vorhanden sind. Fehlt eine benötigte Grundlage, stoppe mit einer präzisen Abhängigkeitsliste. Du darfst Part 01 nicht stillschweigend neu implementieren oder umgehen.

Audit-Anker war Commit `9e538425dd48172cea94e21878c4ff97820dad80`. Bei neuerem Code zählt ausschließlich der aktuelle Stand.

## Scope

1. Upload-/Quota-Fortsetzung: Storage-Abstraktion, S3-kompatibler Object Storage, sichere lokale Test-/Entwicklungsvariante, atomare Bundle-Metadaten und Orphan-Cleanup.
2. Durable Worker für Automationen, Embeddings, Parser, Graphmetriken und periodische Jobs mit Claims, Leases, Idempotency-Key, Retry/Backoff und Dead-Letter-Status.
3. Atomare Optimistic Concurrency und transaktionale Reorder-/Bulk-Mutationen.
4. Cursor-Pagination, begrenzter Bootstrap, granularer Sync und batchweise Hydration.
5. Messbasierte Hot-Path-Indizes und Query-Plan-Regressionstests.
6. SSE-Backpressure, Connection-/Queue-Limits, Idle-TTL und kontrolliertes Drain.
7. Globale und per-Tenant Budgets für Automation, Code-Nodes, HTTP-Nodes und andere Jobs.
8. Konfigurierbarer DB-Pool, Timeouts, `/livez`, `/readyz` und Graceful Shutdown.
9. Container-Härtung, reproduzierbare Images und klare API-/Worker-Rollen.
10. Strukturierte Logs, Request-/Run-IDs und Metriken für relevante SLOs.
11. PostgreSQL-, Crash-, Multi-Worker-, Multi-Replica- und Performance-Integrationstests.

Prüfe insbesondere die aktuellen Entsprechungen der Audit-Hinweise M8 sowie M13 bis M16 und S12 bis S18. Implementiere nur, was im aktuellen Code bestätigt ist.

## Non-goals

- Kein UI-Redesign, keine neue Frontend-Komponentenbibliothek und keine Accessibility-Überarbeitung; das gehört in Part 03.
- Keine Wiederholung der XSS-, OAuth-, Passwort-, SSRF- oder Tenant-Fixes aus Part 01.
- Kein Kubernetes-Manifest, kein Cloud-Vendor-Lock-in und kein vorsorglicher Microservice-Zoo.
- Kein ORM-Rewrite und keine Änderung fachlicher Produktsemantik.
- Kein Redis nur aus Gewohnheit. PostgreSQL bleibt für Claims, Idempotenz und konsistente Limits bevorzugt, solange Messungen keinen anderen Store verlangen.
- Keine unbounded „fetch all“-Kompatibilität unter einem neuen Namen.

## Invarianten

- API-Prozesse sind stateless bezüglich exklusiver Dateien, Scheduler-Leader und Jobbesitz.
- PostgreSQL ist die Quelle für Claims, Lease-Ablauf, Idempotenz, Quotenreservierung und Sync-Cursor.
- Ein externer Side Effect wird pro logischem Job höchstens einmal ausgelöst oder durch denselben Idempotency-Key sicher dedupliziert.
- Lease-Erneuerung, Abschluss und Side Effect gehören in eine dokumentierte Zustandsmaschine; ein Crash lässt Jobs zurückholbar.
- Kein Prozess lädt unbeschränkte Tabellen, Responses oder Uploads vollständig in RAM.
- Jede Liste besitzt ein serverseitiges Maximum und einen stabilen Cursor; Clientwerte können Limits nur verkleinern.
- Versionsprüfung findet in demselben SQL-Statement oder derselben gelockten Transaktion wie die Mutation statt.
- Reorder-/Bundle-Operationen sind vollständig oder gar nicht sichtbar.
- Storage-Objekte werden erst nach erfolgreicher Metadaten-/Quota-Transaktion `ready`; Orphans werden deterministisch entfernt.
- Readiness ist nur grün, wenn DB, erwartete Schema-Version und für die Prozessrolle zwingende Abhängigkeiten verfügbar sind.
- Shutdown nimmt keinen neuen Traffic/Job an, beendet oder übergibt laufende Arbeit kontrolliert und schließt SSE, Listener, Timer und Pool.
- Logs enthalten keine Tokens, Passwörter, Share-Secrets, Uploadinhalte oder unnötige personenbezogene Daten.

## Preflight

Führe read-only aus:

```bash
pwd
git rev-parse HEAD
git status --short
rg -n "setInterval|setTimeout|next_fire_at|FOR UPDATE|SKIP LOCKED|version|reorder|Promise\.all|sync/bootstrap|sync/delta|res\.write|new Pool|/health|UPLOAD_DIR|task_attachments|entity_chunks|pagerank" backend/src nginx docker-compose.yml
```

Nutze für die Abhängigkeiten aus Part 01 ausschließlich den vom Masterprompt validierten Handoff und den aktuellen Code. Lade die vorherige Promptdatei nicht erneut.

Lies die gefundenen Implementierungen, Migrationen und Tests vollständig. Erstelle im Gespräch eine knappe Ist-Matrix: bestätigt, durch Part 01 erledigt, nicht reproduzierbar. Erfasse Baseline-Messungen für Payload, Queryanzahl, Querypläne, p95 und Fehlerrate, bevor du optimierst.

```bash
BASE_COMMIT="$(git rev-parse HEAD)"
```

## Arbeitszyklus je Sprint

1. **Explore:** Daten- und Fehlerfluss einschließlich Crash zwischen jedem Zustandsübergang verfolgen.
2. **Plan:** kleinsten vollständigen Contract, Migration, API-Kompatibilität, Rollback und Messung festlegen.
3. **Implement:** nur diesen Sprint ändern; neue Limits zentral konfigurieren und dokumentieren.
4. **Verify:** Unit-, PostgreSQL-Integration-, Concurrency- und passende Lasttests ausführen.
5. **Frischer Review:** ein frischer Subagent prüft nur Diff, Invarianten, Race-Fenster, Failure Modes und Akzeptanzkriterien. Bestätigte Findings beheben und erneut testen.

Erst bei grünem Contract weitergehen. Vorbestehende Fehler müssen mit Vorher-/Nachher-Evidenz unverändert sein; Tests niemals abschalten oder schwächen.

## Sprint Contracts und Reihenfolge

### B1: Testharness und Prozessrollen

- Reproduzierbare Postgres-Integrationstests mit isolierter Test-DB und deterministischer UTC-Zeit schaffen.
- API-, Worker- und Migrator-Rolle explizit trennen; nur Worker registrieren Timer und Sweeps.
- Testbare Clock-, Query-, Storage- und Side-Effect-Schnittstellen verwenden, ohne unnötige Framework-Abstraktion.
- Gate: Zwei API-Replikas starten ohne doppelte Timer; Integrationstests laufen lokal und in CI gleich.

### B2: Object Storage, Quoten und Bundles

- Eine schmale `StorageAdapter`-Grenze für Stream-Put/Get/Delete/Head schaffen: lokaler Adapter für Entwicklung/Tests, S3-kompatibler Adapter für Produktion.
- Bestehende API-URLs kompatibel halten; keine Storage-Credentials oder internen Keys exponieren.
- Quota Reservation und Objektstatus `pending -> ready` transaktional modellieren. Abbruch gibt Reservierung frei; Janitor entfernt abgelaufene Pending-Objekte und Orphans idempotent.
- Bundle-DB-Zeilen in einer Transaktion schreiben; Fehler rollen Metadaten und Objekte vollständig zurück.
- Gate: parallele Uploads können die Quote nicht überschreiten; Crash vor/nach Upload und DB-Commit konvergiert ohne Leak; Downloads streamen und puffern nicht vollständig.

### B3: Leases, Idempotenz und Worker-Zustandsmaschine

- Fällige Jobs atomar mit `FOR UPDATE SKIP LOCKED` oder äquivalentem Claim übernehmen; `lease_owner`, `lease_expires_at`, Attempts und nächster Versuch persistieren.
- Automation-Schedule, Embeddings, Parser und Graphmetriken auf dieselbe bewährte Primitive vereinheitlichen, ohne domänenspezifische Payloads zu vermischen.
- Externe Aktionen erhalten stabilen Idempotency-Key. Retry mit exponentiellem Backoff/Jitter, Max-Attempts und Dead-Letter-Zustand.
- Chunk-/Bulk-Ersatz über Transaktion oder Staging plus atomaren Swap durchführen.
- Gate: Zwei Worker erzeugen für einen fälligen Job genau einen erfolgreichen Abschluss; Crash nach Claim und vor Ack wird nach Lease-Ablauf übernommen; derselbe Idempotency-Key erzeugt keinen zweiten Side Effect.

### B4: Atomare Concurrency und Bulk-Mutationen

- Alle `SELECT version` plus späteres `UPDATE` durch `UPDATE ... WHERE id=? AND version=? RETURNING` oder gelockte Transaktion ersetzen; null Zeilen ergeben `409`.
- Reorder über validiertes, begrenztes Array und ein Bulk-Statement wie `UPDATE ... FROM unnest(...)` bzw. `VALUES` innerhalb einer Transaktion implementieren.
- Vor Mutation Zugehörigkeit aller IDs zum selben erlaubten Container beweisen; Duplikate, fremde IDs und zu große Arrays ablehnen.
- Gate: Zwei konkurrierende Updates ergeben genau einen Erfolg und einen `409`; injizierter Fehler mitten im Reorder hinterlässt die alte Ordnung vollständig.

### B5: Pagination und granularer Sync

- Cursor-Pagination mit stabiler Sortierung und Tie-Breaker für Listen, Tasks, Timelines, Dateien und weitere bestätigte Aggregate einführen. Default höchstens 50, hartes Maximum 100.
- Bootstrap auf Shell-Daten und erste Seiten begrenzen. Children lazy laden; Delta-Responses höchstens 500 Änderungen und höchstens 1 MiB unkomprimiert pro Seite.
- Geänderte IDs nach Entitätstyp batchweise laden; keine sequenzielle N+1-Hydration. Task-/Section-Änderung nicht als vollständige Großliste senden.
- API-Verträge additiv migrieren. Frontend nur soweit anpassen, wie der neue Vertrag sonst nicht konsumierbar wäre; UX-Arbeit für Part 03 dokumentieren.
- Gate: 10.000 Tasks vergrößern Bootstrap nicht linear; kein Endpoint überschreitet Servermaximum; Cursor liefert ohne Duplikat oder Lücke über konkurrierende Reads.

### B6: Indizes und Querypläne

- Mit realistischem Seed und `EXPLAIN (ANALYZE, BUFFERS)` messen. Prüfe mindestens Attachments nach Parent, Sections nach Liste/Position, Tasks nach Liste/Section/Position und Deadline, Workspace-Listen/Folders/Timelines, Membership und Files nach User/Created.
- Indizes ausschließlich über das versionierte Migrationssystem aus Part 01 hinzufügen. Große Produktionsindizes rollout-fähig und soweit erforderlich concurrent planen.
- Query-Plan-Regressionstests für die wichtigsten Zugriffsmuster ergänzen; keine Indexsammlung ohne Query-Evidenz.
- Gate: auf einem Seed mit mindestens 100.000 relevanten Zeilen verwenden die definierten Hot Queries passende Indizes und zeigen keine bestätigten N+1-Scans.

### B7: SSE, Job-Budgets und Backpressure

- `res.write() === false` behandeln: begrenzte Queue, `drain`, Timeout oder Disconnect. Pro User und Prozess konfigurierbare Connection-Limits, Idle-/Max-TTL und Shutdown-Drain.
- Automation standardmäßig auf höchstens 50 Nodes/Aktionen, 60 Sekunden Gesamtdeadline, vier parallele Runs pro Tenant und ein konfigurierbares globales Limit begrenzen. Einzelne Node-Limits bleiben zusätzlich bestehen.
- Cancellation propagieren; neue Jobs bei Shutdown nicht claimen.
- Gate: ein nicht lesender SSE-Client überschreitet nie 256 KiB Queue; sechste Verbindung wird bei Defaultlimit 5 kontrolliert abgewiesen/ersetzt; übergroßer Graph und Deadline-Überschreitung enden deterministisch.

### B8: Pool, Health, Shutdown und Container

- Poolgröße, Acquire-, Idle-, Statement- und Lock-Timeouts über validierte Konfiguration setzen. Pool-Sättigung messen.
- `/livez` prüft nur den Prozess; `/readyz` prüft DB, Schema-Version und Rollenabhängigkeiten mit kurzem Timeout.
- SIGTERM/SIGINT: Readiness sofort rot, HTTP keep-alive drainen, SSE schließen, Jobs leasen/abschließen oder freigeben, Listener/Timer stoppen, Pool schließen; harte Obergrenze für Shutdown.
- Images per Digest oder reproduzierbaren Patch-Tag pinnen. Backend non-root, `read_only`, gezielte writable Mounts/tmpfs, `cap_drop: ALL`, `no-new-privileges`, PID-/CPU-/RAM-Limits und `.dockerignore`.
- Gate: Readiness wird bei DB-Ausfall innerhalb von 5 Sekunden rot; Shutdown endet innerhalb von 30 Sekunden ohne neuen Claim; Container schreibt nur in erlaubte Pfade und startet non-root.

### B9: Observability und Skalierungsbeweis

- Strukturierte JSON-Logs mit Request-ID, User nur pseudonymisiert, Workspace/Run/Job-ID soweit nötig und Fehlerkette. Keine freien Secrets.
- Metriken mindestens für Request p50/p95/p99, Fehlerrate, Poolauslastung/Wartezeit, Queuealter, Lease-Reclaims, Retries/Dead Letters, Outbox-Lag, SSE-Verbindungen/Disconnects/Backpressure, Uploadbytes/Quota und Worker-Dauer.
- Health-/Metrics-Endpunkte getrennt schützen; keine High-Cardinality-Labels mit Roh-IDs.
- Referenzlasttest: 25 parallele Clients für 60 Sekunden, Fehlerquote unter 1 %, p95 für paginierte Reads unter 750 ms und für einfache Mutationen unter 500 ms auf dokumentiertem Docker-Testprofil. Baseline und Ergebnis versionierbar ausgeben.
- Gate: Test mit zwei API- und zwei Worker-Instanzen zeigt keine doppelten Scheduler-Side-Effects, keine verlorenen Jobs und konsistente Rate-/Connection-Budgets.

## Stop-Bedingungen

Stoppe und frage konkret nach, wenn:

- fremde Worktree-Änderungen dieselben Dateien betreffen;
- Part 01 oder das versionierte Migrationssystem fehlt bzw. rot ist;
- Pagination oder Storage-Wechsel einen externen Client ohne additive Übergangsstrategie brechen würde;
- S3-, TLS-, Proxy- oder Produktions-Retention-Annahmen nicht aus Konfiguration belegbar sind;
- ein Daten-Backfill nicht eindeutig, reversibel oder mit realistischem Zeitbudget ausführbar ist;
- genau-einmalige externe Wirkung vom Zielsystem keine Idempotenz unterstützt; dokumentiere dann ehrlich At-least-once plus Deduplizierungsgrenze;
- Messungen ein anderes Bottleneck zeigen als der Audit-Hinweis.

Nutze keine Sleeps als Concurrency-Beweis, keine globalen In-Memory-Locks als Multi-Replica-Lösung und keine pauschalen Retries ohne Idempotenz.

## Exakte Abschluss-Gates

Ergänze stabile Scripts `test:integration` und `test:performance`, falls sie fehlen. Führe mindestens aus:

```bash
(cd backend && npm run build)
(cd backend && TEST_UPLOAD_DIR="$(mktemp -d)" && TZ=UTC UPLOAD_DIR="$TEST_UPLOAD_DIR" npm test)
(cd backend && TZ=UTC npm run test:integration)
(cd backend && TZ=UTC npm run test:performance)
(cd frontend && npm test)
(cd frontend && npm run build)
docker compose config --quiet
docker compose build backend frontend
git diff --check
git status --short
```

Alle neuen Migration-, Storage-, Lease-, Crash-, Concurrency-, Pagination-, Query-Plan-, SSE- und Shutdown-Tests müssen Teil dieser Befehle sein. Kein Gate darf von lokaler Zeitzone, festem `/app/uploads`-Pfad oder einem bereits befüllten Entwickler-DB-Schema abhängen.

## Handoff an Part 03

Berichte beweisorientiert:

1. Outcome je Sprint, geänderte Dateien/Migrationen und neue Zustandsmaschinen.
2. API-Vertragsänderungen: Cursor, Limits, Fehlercodes, Partial-/Stale-Semantik und Rückwärtskompatibilität.
3. Exakte Test-, Build-, Docker- und Lasttestbefehle mit Ergebnissen und Testprofil.
4. Vorher-/Nachher-Werte für Payload, Queryanzahl, Queryplan, p95, Fehlerrate, Pool, Queuealter und SSE-Backpressure.
5. Rolloutreihenfolge für Migration, Storage, API und Worker sowie sichere Rollback-Schalter.
6. Offene Risiken und alles, was Part 03 im Frontend für Pagination, Loading, Error, Retry und Sync UX umsetzen muss.
7. `git diff --stat` und Bestätigung, dass weder Commit noch Push erfolgt ist.
