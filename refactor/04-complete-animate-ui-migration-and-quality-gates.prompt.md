# Claude-Code-Prompt 04: Vollständige Animate-UI-Migration und Quality Gates

## Auftrag

Arbeite direkt im Repository `solytiq-cloud` in der Reihenfolge Explore -> Plan -> Implement -> Verify -> frischer Review -> Handoff.

Migriere jede First-Party-UI-Animation auf die in Sprint 03 validierte Animate-UI-Schicht. Vollständigkeit muss maschinenprüfbar sein. Beginne keine breite Migration vor vollständiger Inventur und grünem Eingangsgate.

## Ground Truth und Eingangsgate

- Aktueller Code, Lockfiles, Tests und Laufzeitkonfiguration sind die technische Wahrheit.
- Lies die für deinen Scope geltenden Repository-Instruktionen vollständig. Befolge operative Sicherheits-, Workflow- und Stilregeln. Behandle darin beschriebene Architektur, Dependencies und Dateistrukturen als zu verifizierende Hinweise. Bei einem Konflikt mit Masterauftrag oder aktuellem Code stoppe mit Evidenz, statt die Dokumentation als Wahrheit zu erzwingen.
- Lies den vollständigen Sprint-03-Handoff. Beginne nur bei `ANIMATE_UI_SPIKE=GREEN` und wenn die Branch auf dessen Ergebnis basiert.
- Quelle/Version, Primitive-Familie, Tailwind-Integration, Pilot, Peer-Matrix und Tests aus Sprint 03 müssen reproduzierbar sein. Sonst stoppe.
- Audit, Dokumentation, frühere Zeilen und Inventurzahlen sind nur Hinweise; erhebe alles neu.
- Animate UI ist eine kopierte Registry-Distribution, kein pauschal zu installierendes `animate-ui`-Paket.
- Verwende nur die gepinnte, in Sprint 03 geprüfte Quelle und genau dessen Primitive-Familie.
- `MotionConfig reducedMotion="user"` muss genau einmal an der App-Wurzel wirksam sein.
- Bekannte grobe Werte des Audit-Commits waren 63 First-Party-`@keyframes`, 19 Dateien mit direkten `motion/react`-Imports, hunderte `animation`-/`transition`-Properties und mehrere `requestAnimationFrame`-Schleifen. Diese Werte sind keine Abnahmebasis.

## Definition „vollständig“

- Jede First-Party-UI-Bewegung läuft über die validierte Animate-UI-Schicht oder dort zentral gekapselte Animate-UI-/Motion-Primitives.
- Feature-, Screen-, Modal-, Hook- und Store-Code importiert `motion/react` nicht direkt.
- Keine verstreuten CSS-Keyframes, Inline-Animationen, injizierten Keyframe-Styles oder unkontrollierten UI-Transitions verbleiben.
- Erfasst sind Eintritt/Austritt, Layoutwechsel, Hover/Press, Expand/Collapse, Overlay, Tabs, Loading, Progress, Erfolg/Fehler, Drag-Feedback und kontinuierliche dekorative Bewegung.
- First-Party-SVG-, Canvas- und `requestAnimationFrame`-Bewegung wird inventarisiert und nicht still als „technisch“ ausgeschlossen.
- Unveränderter Code aus `node_modules` und unveränderte Third-Party-CSS sind kein First-Party-Code. Eigene Wrapper, Overlays und Simulationsschleifen sind First-Party-Code.
- Ist eine notwendige First-Party-Animation nicht ohne Funktions-, A11y- oder Performanceverlust migrierbar, stoppe. Keine heimliche Allowlist.

## Scope

- Vollständige Animation-Migration aller First-Party-Frontendquellen.
- Ablösung globaler/lokaler Keyframes, `<style>`-Blöcke, Inline-Animationen, roher Motion-Nutzung und visueller Frame-Loops.
- Einheitliche Animate-UI-Primitives und Motion-Tokens für alle Features.
- Reduced Motion für UI, AI, GPS, Graph, SVG, Canvas und kontinuierliche Effekte.
- Visual-, Accessibility-, Keyboard-, Responsive- und Performance-Verifikation.
- M19: CI-Gates für Build, Lint, Tests, A11y, E2E, Bundle, Animation-Policy, SCA, Container und PostgreSQL-Integration.
- S20: abschließender Abgleich von Dokumentation und Dependency-Inventar mit dem implementierten Code.
- K3: Accessibility- und Visual-E2E für kritische Flows.

## Non-goals

- Kein visueller Relaunch und keine flächendeckende Style-zu-Tailwind-Migration.
- Keine Backend-Fachlogik-, Auth- oder API-Vertragsänderung.
- Kein Austausch von Leaflet, Sigma, Graphology oder React Flow nur aus ästhetischen Gründen.
- Keine zweite Primitive-Familie oder Animationsbibliothek.
- Keine ungemessene Änderung von Physik, Dauer oder Easing.
- Kein Release, Push oder Versions-Bump.

## Invarianten

- Benutzerflüsse, Datenverhalten und Autorisierung bleiben kompatibel.
- Solytiq-Design und semantische Tokens bleiben erhalten; Tailwind bleibt additiv.
- Animation blockiert keine Eingabe und verschleiert keinen Lade-/Fehlerzustand.
- Bevorzuge Transform/Opacity; schließe Layout-Thrashing durch Messung aus.
- Exit-Animationen dürfen Fokus-Rückgabe, Routing und Cleanup nicht beschädigen.
- Reduced Motion deaktiviert große Transformationen, Auto-Scroll, Parallax und Dauerschleifen; Inhalt/Status bleiben sichtbar.
- Nur die zentrale Animate-UI-Schicht darf rohe Motion-Primitives importieren.
- Keine TypeScript-Lockerung, Pattern-Umbenennung oder deaktivierte Prüfung als Abkürzung.
- Keine fremden Änderungen überschreiben und keine unbeteiligten Dateien anfassen.

## Preflight

```bash
pwd
git rev-parse HEAD
git status --short
git log -5 --oneline
test -f CLAUDE.md
test -f frontend/package-lock.json
cd frontend
npm ci
npm run build
npm test
npm run test:a11y
npm run check:bundle
npm run lint
npm ls react react-dom motion
```

Stoppe bei fremden Änderungen oder rotem Sprint-03-Gate. Setze nichts zurück. Prüfe erneut Upstreamreferenz/Lizenz, gepinnte CLI, eine Primitive-Familie, einfache React-/Motion-Laufzeit, Root-MotionConfig, additive Tailwind-Konfiguration und Bundle-Budget.

## Sprint Contract

Für jede Phase:

1. Vor dem Ändern inventarisieren.
2. Jede Fundstelle einer Zielprimitive und Reduced-Motion-Regel zuordnen.
3. Test zuerst oder zusammen mit der Migration ergänzen.
4. Kleine, kohärente Featuregruppen migrieren.
5. Nach jeder Gruppe Policy, Tests, Build und relevante E2E-Flows ausführen.
6. Erst bei Grün fortsetzen.
7. Bei notwendiger Ausnahme stoppen und Entscheidung anfordern.
8. Keine separate Backlogdatei; Ergebnisse kommen in den Handoff.

## Phase 0: Maschinenprüfbare Inventur

1. Implementiere ein nicht interaktives Script `check:animations`, das First-Party-Frontendquellen rekursiv prüft.
2. Es erkennt mindestens:
   - `@keyframes`
   - CSS-/Inline-Properties `animation`, `animationName` und `transition*`
   - direkte Imports aus `motion/react` oder `framer-motion`
   - `motion.*`, `AnimatePresence`, rohe Varianten/Controls außerhalb der zentralen Schicht
   - Web Animations API und `Element.animate()`
   - `requestAnimationFrame`/`cancelAnimationFrame`
   - dynamische `<style>`-Blöcke und Keyframe-Strings
   - animierte SVG-Properties und Stroke-Loops
3. Schließe nur unveränderte Third-Party-Quellen und den exakt definierten zentralen Animate-UI-Bereich aus.
4. Eine Policy-Konfiguration startet ohne fachliche Allowlist-Ausnahmen.
5. Erzeuge eine maschinenlesbare Inventur mit Datei, Kategorie und Fundart.
6. Klassifiziere jede Fundstelle: Overlay/Fokus, Navigation/Seite, Layout, Hover/Press, Loading/Status, Drag, AI, GPS, Graph/SVG/Canvas/Simulation oder rein technisches Scheduling.
7. „Rein technisch“ benötigt einen Test, dass keine visuelle Bewegung gesteuert wird; sonst bleibt die Stelle migrationspflichtig.

Beginne Phase 1 erst, wenn jede Fundstelle klassifiziert, einer Zielprimitive zugeordnet und mit Verifikationsplan versehen ist.

## Phase 1: Zentrale Schicht und Overlays

1. Konsolidiere Dauer, Easing, Feder, Stagger, Exit und Reduced Motion in der validierten Animate-UI-Schicht.
2. Migriere Dialog, Alert Dialog, Sheet, Popover, Dropdown, Tooltip, Tabs, Accordion und verwandte Overlays zuerst.
3. Bewahre Fokusfalle, Escape, Outside Click, Scroll Lock, Portal-Ziel und Fokus-Rückgabe.
4. Entferne manuelle Overlay-Keyframes erst nach grünen Tests aller Nutzer.
5. Feature-Code verwendet nur Solytiq-/Animate-UI-Primitives, keine rohen Motion-Imports.

## Phase 2: Shell, Navigation und Feedback

Migriere in Batches:

1. App-Shell, Route- und View-Wechsel
2. Sidebar, TopBar, Command Palette, Context Menus, Benachrichtigungen
3. Auth-, Setup-, Share- und Settings-Flows
4. Skeleton, Spinner, Save-Status, Erfolg, Fehler und Retry
5. Card-, Section-, List- und Empty-State-Eintritte
6. Hover-, Press-, Toggle-, Auswahl- und Drag-Feedback

Nach jedem Batch: normale Bewegung, Reduced Motion, Tastatur und Bundle prüfen.

## Phase 3: Modals, Editoren und Feature-Screens

Migriere danach:

1. alle Wizard- und Settings-Modals
2. Task-, Timeline-, Calendar- und List-Flows
3. Markdown- und Knowledge-Editoren
4. Files, Templates und Automations
5. AI Assistant, Chat, Recent Chats und AI-Skill-Modals
6. Drag-and-drop mit gleichwertiger Tastaturalternative

Teste Öffnen, Schließen, Unterbrechen, schnelles Wiederöffnen, Navigation während Exit und Fehlerzustände.

## Phase 4: GPS, Graph, SVG, Canvas und Dauerbewegung

1. Migriere eigene GPS-Panel-, Marker-, POI- und Fortschrittsanimationen.
2. Migriere eigene Graph-Glow-, Edge-, Node- und Inspector-Animationen.
3. Überführe visuelle Frame-Logik in die zentrale Motion-Schicht oder passende Animate-UI-Primitives, ohne Physik/Interaktion zu verändern.
4. Pausiere Dauerbewegung bei Hidden State, inaktiver Route, niedriger Energie und Reduced Motion.
5. Third-Party-Renderer bleiben nur unverändert, wenn Bewegung vollständig im unveränderten Third-Party-Code liegt.
6. Miss CPU, Main Thread und Frame-Stabilität vor/nachher mit reproduzierbaren Daten.

Ist eine First-Party-Simulation nicht verlustfrei migrierbar, stoppe statt sie auszulassen.

## Phase 5: Altcode entfernen und Policy schließen

1. Entferne ersetzte globale/lokale Keyframes, injizierte Animationsstyles und Inline-Animationen.
2. Entferne `motionTokens.ts`, falls vollständig ersetzt. Ein verbleibender Adapter muss Teil der validierten Animate-UI-Schicht sein und darf keine Legacy-API konservieren.
3. Entferne unbenutzte Animationsdependencies nur nach Lockfile-/Build-Nachweis.
4. Schalte `check:animations` strikt: Jede neue Legacy-Fundstelle liefert Exitcode ungleich null.
5. Verifiziere, dass keine CSS-/JS-Animation MotionConfig oder Reduced Motion umgeht.

Vollständig ist die Migration nur bei null Legacy-Fundstellen, null fachlichen Allowlist-Ausnahmen, migrierter Startinventur und roher Motion-Nutzung ausschließlich in der zentralen Schicht.

## Phase 6: A11y, Visual E2E, Responsive und Performance

1. Playwright-Flows für Login, Navigation, Dialoge, Picker, Shares und Drag-Alternativen ergänzen.
2. Axe oder gleichwertige A11y-Prüfung für kritische Screens/Primitives integrieren.
3. Normale und reduzierte Bewegung bei 320, 375, 390, 768, 1024 und 1440 Pixel testen.
4. Tastatur prüfen: Tab, Escape, Fokusfalle/-Rückgabe, Menüs, Popover, Tabs, Picker, Drag-Alternative.
5. Deterministische Visual-Snapshots über Reduced Motion oder kontrollierte Testzeit erstellen.
6. Schnelle Wiederholung, Route-Wechsel während Exit und Unmount-Cleanup testen.
7. Initiale und Route-Chunks messen; initial höchstens 250 kB gzip.
8. GPS/Graph mit realistischen Daten auf Long Tasks und unnötige Loops prüfen.

## Phase 7: CI und Dokumentations-Endabgleich

1. Frontend-Lint auf null Fehler bringen.
2. Build, Unit, A11y, E2E, Bundle und Animation-Policy als nicht interaktive CI-Gates einrichten.
3. Backend-Build, umgebungsneutrale Tests, SCA, Docker-Build und PostgreSQL-Integration als CI-Gates ergänzen, soweit Sprint 01/02 sie nicht bereits liefern.
4. Das vorhandene n8n-Paket mit Build, Tests und Runtime-SCA als CI-Gates abdecken.
5. CI-Runtimes/Actions gemäß Repository-Policy pinnen.
6. Architekturtexte nur gemäß implementiertem Code korrigieren: Registry-Distribution, Primitive-Familie, additives Tailwind und Motion-Policy.
7. Dependency-Inventar und Bundle-Budget aus Lockfile/Build ableiten statt doppelt pflegen.
8. Bei `CLAUDE.md`-Änderung dessen Synchronisationsregeln einhalten.

## Exakte Verifikation

```bash
cd frontend
npm ci
npm run check:animations
npm run check:bundle
npm run build
npm test
npm run test:a11y
npm run test:e2e
npm run lint
npm audit --omit=dev --audit-level=high
npm ls react react-dom motion
cd ../backend
npm ci
npm run build
SOLYTIQ_TEST_UPLOAD_DIR="$(mktemp -d)"
UPLOAD_DIR="$SOLYTIQ_TEST_UPLOAD_DIR" TZ=UTC npm test
npm audit --omit=dev --audit-level=high
cd ../n8n
npm ci
npm test
npm run build
npm audit --omit=dev --audit-level=high
cd ..
docker compose config
git diff --check
git status --short
git diff --stat
```

Ein SCA-Netzwerkfehler ist kein Grün. Zusätzliche Repository-CI-/Integrationstests ebenfalls ausführen.

## Frischer Review

Lies Auftrag und jede geänderte Datei erneut. Prüfe den Diff wie Fremdcode. Suche repositoryweit erneut nach allen Policy-Mustern und gleiche Start-/Endinventur ab. Prüfe besonders direkte Motion-Imports, lokale Styles, Inline-Transitions, Exit-Cleanup, Fokus, Reduced Motion, layout-teure Properties, GPS-/Graph-Loops, Tailwind-/Token-Regressions, eager Imports, Bundle und flakige Tests. Behebe Befunde und wiederhole betroffene Gates.

## Akzeptanzkriterien

- `check:animations` ist dokumentiert, CI-tauglich und grün.
- Jede Startfundstelle ist nachweisbar migriert; keine fachliche Allowlist-Ausnahme existiert.
- Keine First-Party-Keyframes, rohen Motion-Imports, injizierten Keyframes oder unkontrollierten UI-Transitions außerhalb der zentralen Schicht.
- Genau eine Primitive-Familie und Motion-Laufzeit; Root-MotionConfig ist wirksam.
- Reduced Motion stoppt große/automatische/Dauerbewegung ohne Inhaltsverlust.
- Overlay-/Picker-Flows bestehen Tastatur/Fokus; Axe hat keine Serious/Critical-Befunde.
- Visual-Tests sind deterministisch; alle Zielbreiten sind bedienbar.
- Initialer App-Chunk höchstens 250 kB gzip; schwere Features bleiben lazy.
- GPS-/Graph-Performance ist nicht schlechter; unnötige Loops sind entfernt.
- Frontend-, Backend-, Docker-, SCA- und CI-Gates sind grün.
- Dokumentation entspricht ausschließlich dem Code.

## Stop-Bedingungen

Stoppe bei rotem/fehlendem Sprint-03-Spike, falscher Branch, Fremdänderungen, nicht reproduzierbarer Quelle/Lizenz, zweiter Primitive-Familie, doppeltem React/Motion, notwendiger nicht verlustfrei migrierbarer First-Party-Animation, erforderlicher Allowlist/Prüfungsumgehung, Bundle-Gate nur durch Funktionsverlust, unsicherem Reduced Motion, Backend-Vertragsbruch oder Bedarf an echten Secrets/Produktdaten. Teilmigration nie als vollständig ausgeben.

## Handoff

Liefere:

1. Start-/Endstand und Dateien je Phase.
2. Animate-UI-Quelle, Version, Familie und Dependency-Lock.
3. Start-/Endinventur je Kategorie und Zielprimitive.
4. Bestätigung „keine Ausnahme“ oder klaren Blocker.
5. Reduced-Motion-Matrix für UI, AI, GPS, Graph, SVG und Canvas.
6. A11y-, Keyboard-, Responsive-, Visual-, Bundle- und Performance-Ergebnisse.
7. Befehle mit Exitcodes, CI-Workflows, Dokuabgleich und Risiken.
8. Genau `ANIMATE_UI_MIGRATION=COMPLETE` oder `ANIMATE_UI_MIGRATION=BLOCKED`.

`COMPLETE` ist nur bei vollständig grünen Akzeptanzkriterien zulässig.
