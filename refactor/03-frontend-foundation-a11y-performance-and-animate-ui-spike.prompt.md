# Claude-Code-Prompt 03: Frontend-Fundament, A11y, Performance und Animate-UI-Spike

## Auftrag

Arbeite direkt im Repository `solytiq-cloud`. Implementiere Sprint 03 in dieser Reihenfolge:

1. Explore
2. Plan
3. Implement
4. Verify
5. frischer Review
6. Handoff

Beginne nicht mit Produktänderungen, bevor Codebefund, Animate-UI-Kompatibilität und Plan belastbar sind.

## Ground Truth

- Aktueller Code, Lockfiles, Tests und Laufzeitkonfiguration sind die technische Wahrheit.
- Lies die für deinen Scope geltenden Repository-Instruktionen vollständig. Befolge operative Sicherheits-, Workflow- und Stilregeln. Behandle darin beschriebene Architektur, Dependencies und Dateistrukturen als zu verifizierende Hinweise. Bei einem Konflikt mit Masterauftrag oder aktuellem Code stoppe mit Evidenz, statt die Dokumentation als Wahrheit zu erzwingen.
- Lies den Sprint-02-Handoff. Fehlt er oder basiert die Branch nicht darauf, stoppe.
- Audit und Dokumentation sind nur Hinweise. Bestätige oder widerlege jeden Befund am aktuellen Code.
- Audit-Referenz war `9e538425dd48172cea94e21878c4ff97820dad80`; Zeilen und Messwerte können veraltet sein.
- Damals vorhanden: React 19.2, TypeScript 6, Vite 6, React Router 7, Zustand 5, Motion 13. Nicht vorhanden: Tailwind, shadcn/ui, Animate UI. Prüfe dies erneut.
- Animate UI ist eine kopierbare Registry-Distribution aus React, TypeScript, Tailwind, Motion und shadcn-Prozess, kein klassisches NPM-Paket.
- Prüfe nur aktuelle offizielle Quellen: `animate-ui.com/docs`, deren Installation/Accessibility-Seiten und die shadcn-Vite-/Tailwind-v4-Dokumentation.
- Führe im Handoff je Auditpunkt `CONFIRMED`, `ALREADY_FIXED`, `REFUTED` oder `BLOCKED`.

## Scope

- M17: korrekte rollenbasierte Anzeige von Workspace-Einstellungen plus Tests pro Rolle.
- Strukturelle Teile von M18: Route-Splitting, sichtbare Lade-/Fehler-/Leerzustände, Error Boundaries, Semantik, Fokus, Formulare, Tastatur, Kontrast und responsive GPS-UX.
- S5 bis S11: Chunks, Zustand-Selektoren, Sidebar-/Graph-CPU, Design-Primitives, Navigation, Formulare, mobile GPS-Architektur und ehrliche Zustände.
- Frontend-Teil von S19, soweit Modulgrenzen die genannten Ziele direkt ermöglichen.
- Animate-UI-Kompatibilitäts-Spike, genau eine Primitive-Familie, ein kleiner Produktionspilot und bei grünem Gate `MotionConfig reducedMotion="user"`.
- Ausgangsinventur aller First-Party-Animationen für Sprint 04.

## Non-goals

- Keine vollständige Animationsmigration; diese gehört ausschließlich in Sprint 04.
- Kein visueller Relaunch und keine flächendeckende Inline-Style-zu-Tailwind-Migration.
- Keine Backend-, Datenmodell-, Auth-, Pagination- oder Sync-Vertragsänderung.
- Keine neue Routing-, State- oder Form-Library ohne reproduzierbaren Bedarf.
- Keine zweite Primitive-Familie; Radix, Base UI und Headless UI nicht mischen.
- Kein Release, Push oder Versions-Bump.

## Invarianten

- Benutzerflüsse und API-Verträge bleiben kompatibel; Backend-Autorisierung bleibt maßgeblich.
- Bestehende Solytiq-Tokens und visuelle Identität bleiben erhalten.
- Tailwind nur additiv und erst nach grünem Pilotgate. `frontend/src/index.css` nicht ersetzen.
- Tailwind-Reset/Preflight darf Controls, Typografie, Leaflet, Sigma, React Flow und Editoren nicht unbemerkt verändern.
- Animate-UI-Quellen mit unveränderlicher Upstream-Referenz und Lizenz übernehmen.
- Genau eine Primitive-Familie für Dialog, Sheet, Popover, Dropdown, Tabs, Switch und verwandte Controls.
- Keine doppelten React-, React-DOM- oder Motion-Versionen.
- Keine leeren sichtbaren `Suspense`-, Auth- oder Feature-Gates.
- Neue/geänderte Interaktionen funktionieren ohne Maus und mit Reduced Motion.
- Keine fremden Änderungen überschreiben und keine unbeteiligten Dateien anfassen.

## Preflight

```bash
pwd
git rev-parse HEAD
git status --short
git log -5 --oneline
test -f CLAUDE.md
test -f frontend/package-lock.json
sed -n '1,220p' frontend/package.json
sed -n '1,160p' frontend/vite.config.ts
sed -n '1,140p' frontend/src/main.tsx
sed -n '1,120p' frontend/src/App.tsx
cd frontend
npm ci
npm run build
npm test
npm run lint
```

Stoppe bei unerwarteten Änderungen in deinem Scope. Setze nichts zurück. Falls die Baseline scheitert, klassifiziere Altfehler exakt; alle geänderten Dateien müssen trotzdem fehlerfrei sein.

Erhebe neu:

- initiale und route-spezifische gzip-Chunks
- statische/lazy Screens und schwere Modals
- leere Suspense-, Auth- und Feature-Gates
- Whole-Store-Subscriptions und unnötige Rerenders
- Keyframes, CSS-Transitions, direkte Motion-Imports, Inline-/injizierte Animationen und `requestAnimationFrame`
- Dialoge, klickbare Nicht-Controls, entfernte Outlines, Labels und Landmarken
- Layout bei 320, 375, 390, 768, 1024 und 1440 Pixel

## Sprint Contract

Für jede Phase:

1. Befund mit aktuellem Pfad/Zeile bestätigen.
2. Kleine, testbare Zielbedingung formulieren.
3. Regressionstest zuerst oder zusammen mit dem Fix ergänzen.
4. Kleinsten kohärenten Änderungssatz implementieren.
5. Phasentests ausführen; erst bei Grün fortsetzen.
6. Keine separate Findings-Datei; Ergebnisse kommen in den Handoff.

## Phase 0: Animate-UI-Kompatibilität

1. Prüfe offizielle Animate-UI-/shadcn-Quellen auf Aktualität.
2. Ermittle und pinne eine exakte shadcn-CLI-Version; dauerhaft kein `@latest`.
3. Ermittle offizielle Registry-URLs für Pilotkomponenten. Nutze zuerst den read-only `view`-Befehl.
4. Prüfe per CLI-Hilfe, ob ein echter Dry-Run existiert. Nutze ihn, falls vorhanden. Andernfalls Registry-JSON/Quellen manuell oder in einem temporären Verzeichnis prüfen. Nichts ungeprüft überschreiben.
5. Erstelle eine Matrix für React 19.2, React DOM, Strict Mode, TypeScript 6, Vite 6, Motion/Peers, Tailwind 4, `@tailwindcss/vite`, shadcn-Schema, Utilities, Primitive-Abhängigkeiten, Browserziele, Lizenz und Bundle.
6. Wähle exakt eine Primitive-Familie anhand A11y, Kompatibilität, Dependency-Fläche und Bundle.
7. Prüfe `npm ls react react-dom motion` auf doppelte Laufzeiten.

### Pilotgate

Ein repräsentativer Overlay-Primitive und ein kleiner Motion-Effekt müssen im echten Vite-Projekt bestehen:

- TypeScript-Build ohne Animate-UI-bedingtes `skipLibCheck`
- Strict Mode ohne doppelte Side Effects
- zugänglicher Name, Fokusfalle, Escape und Fokus-Rückgabe
- normale und reduzierte Bewegung
- unveränderte Design-Tokens und keine globale CSS-Regression
- keine doppelten Laufzeiten
- gemessene akzeptable Chunk-Auswirkung

Bei Rot stoppe. Erfinde keine angeblich kompatible Ersatzschicht.

## Phase 1: Additives Primitive-Fundament

Nur bei grünem Pilotgate:

1. Tailwind 4 minimal/additiv einrichten, nur soweit übernommene Komponenten es brauchen.
2. Bestehende CSS-Variablen über eine kleine Token-Brücke nutzen; kein zweites Farbsystem.
3. Nur benötigte Animate-UI-Quellen in `frontend/src/components/animate-ui/` übernehmen.
4. Hinter stabilen Solytiq-Primitives kapseln. Prüfe mindestens `Button`, `IconButton`, `Input`, `Dialog`, `AlertDialog`, `Sheet`, `Popover`, `Dropdown`, `Switch`, `Tabs`, `Skeleton`, Error und Empty State.
5. `MotionConfig reducedMotion="user"` genau einmal an der App-Wurzel setzen.
6. `:focus-visible`, Kontrast sowie Disabled-, Busy- und Loading-Zustände vereinheitlichen.
7. Nur Pilot- und A11y-Call-Sites migrieren; Legacy-Animationen noch nicht global löschen.

## Phase 2: Routing und Zustände

1. Alle Route-Screens und schwere bedarfsabhängige Features/Modals lazy laden.
2. Sigma, Graphology, Leaflet, React Flow und Editoren aus dem initialen Chunk halten.
3. Leere Gates durch zugängliche, visuell stabile Zustände ersetzen.
4. Route- und Feature-Error-Boundaries mit Retry einführen.
5. `loading`, `refreshing`, `empty`, `partial`, `stale` und `error` ehrlich trennen.
6. Dimensionierte Skeletons gegen Layout Shift verwenden.
7. Nicht interaktiven Bundle-Check ergänzen; initialer App-Chunk höchstens 250 kB gzip.

## Phase 3: Rollen, Semantik und Formulare

1. M17 im aktuellen Code reproduzieren; tautologische Vergleiche entfernen und Sichtbarkeit aus echter Serverrolle/korrekter User-ID ableiten.
2. Rollen-UI für Owner, Manager/Admin, Member und Unberechtigte gemäß realem Modell testen.
3. `main`, `nav`, Skip-Link, Überschriften und `aria-current` ergänzen.
4. Klickbare Nicht-Controls in geänderten Kernflüssen durch native Controls oder vollständige Tastatursemantik ersetzen.
5. Labels, Hilfe und Fehler mit `htmlFor`, `aria-invalid`, `aria-describedby` verbinden; Status dosiert per Live-Region melden.
6. Dialoge, Menüs und Popover im Scope auf die gewählte Familie bringen.
7. CalendarPicker/TimePicker mit belegbarem WAI-ARIA-Tastaturmuster versehen. Vor Library-Wechsel bei ungeklärter Produktentscheidung stoppen.
8. Für Drag-and-drop-Kernaktionen eine Tastatur-/Menüalternative ergänzen.

## Phase 4: Rendering und Responsive UX

1. Whole-Store-Subscriptions durch Selektoren, `useShallow` oder stabile Actions ersetzen.
2. Sidebar-Gruppierung linear vorberechnen und nur messbar sinnvoll memoizieren.
3. First-Party-Graph-Simulation bei niedriger Energie/inaktiver Route pausieren; Algorithmus nur mit Benchmark ändern.
4. Virtualisierung ausschließlich nach Profiler-Nachweis mit realistischen Daten.
5. Feste mobile GPS-Seitenleisten durch Tabs, Sheets oder responsive Overlays ersetzen; `100dvh` und Safe Areas beachten.
6. Alle Zielbreiten ohne blockierenden Overflow, abgeschnittene Controls oder unerreichbare Aktionen testen.

## Verify und frischer Review

Fehlende vereinbarte Scripts nicht interaktiv ergänzen:

```bash
cd frontend
npm ci
npm run build
npm test
npm run test:a11y
npm run check:bundle
npm run lint
npm ls react react-dom motion
git diff --check
git status --short
git diff --stat
```

Lies anschließend jede geänderte Datei neu. Prüfe globale CSS-Nebenwirkungen, Fokus, Retry, Empty/Error, Rollen, doppelte Dependencies, eager Imports, neue direkte Motion-Nutzung, Reduced Motion und 320/1440 Pixel. Behebe Befunde und wiederhole betroffene Gates.

## Akzeptanzkriterien

- Reale Animate-UI-Kompatibilität mit gepinnten Quellen/Versionen ist bewiesen.
- Tailwind ist additiv integriert; genau eine Primitive-Familie ist gewählt.
- `MotionConfig reducedMotion="user"` existiert genau einmal.
- Kein sichtbares Route-/Auth-Gate bleibt feedbacklos `null`.
- Initialer App-Chunk höchstens 250 kB gzip.
- Geänderte Dialoge erfüllen Name, Fokusfalle, Escape und Fokus-Rückgabe.
- Rollenanzeige ist serverkonform getestet; Navigation besitzt Skip-Link, Landmarken und `aria-current`.
- Geänderte Formfehler sind programmatisch zugeordnet; Zielbreiten sind bedienbar.
- Build, Tests, A11y- und Bundle-Gate sind grün; alle geänderten Dateien lint-frei.
- Vollständige Altanimations-Ausgangsinventur ist für Sprint 04 übergeben, aber nicht als migriert bezeichnet.

## Stop-Bedingungen

Stoppe bei fehlendem Sprint-02-Handoff, überlappenden Fremdänderungen, unverifizierbarer Quelle/Lizenz, Stack-/Peer-Inkompatibilität, doppeltem React/Motion, nicht isolierbarer Tailwind-Regression, erforderlichem Backend-Vertragsbruch, ungeklärtem Library-Wechsel, unerreichbarem Bundle-Gate ohne Funktionsverlust oder Bedarf an echten Secrets/Produktdaten.

## Handoff an Sprint 04

Liefere:

1. Start-/Endstand und geänderte Dateien pro Phase.
2. Auditstatus im Scope.
3. Exakte Animate-UI-Quelle, Registry/Commit, CLI-Version, Lizenz und Komponenten.
4. Gewählte Primitive-Familie samt Begründung und Peer-Matrix.
5. Tailwind-/Token-Integration und öffentliche Primitive-APIs.
6. Vollständige aktuelle Animationsinventur samt Suchregeln.
7. Bundle-/Profiler-/Responsive-Vorher/Nachher.
8. Befehle, Exitcodes, Altfehler, Risiken und Blocker.
9. Genau `ANIMATE_UI_SPIKE=GREEN` oder `ANIMATE_UI_SPIKE=BLOCKED`.

Sprint 04 darf nur bei `ANIMATE_UI_SPIKE=GREEN` beginnen.
