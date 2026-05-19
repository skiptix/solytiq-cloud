import { useState, useEffect, useRef } from "react";

const DEFAULT_SECTIONS = [
  {
    id: "rad",
    icon: "🚴",
    title: "Rad & Antrieb",
    items: [
      { id: "r1", name: "Stevens Camino Pro AXS", note: "SRAM Force AXS, 44/10-44 — Schaltwerk prüfen", badge: null },
      { id: "r2", name: "Aerobars montiert & eingestellt", note: "Armlageposition für 10h+ testen", badge: null },
      { id: "r3", name: "Vittoria Terreno Dry 45mm", note: "Reifendruck prüfen, empfohlen 3.0–3.5 bar", badge: null },
      { id: "r4", name: "Ersatzschlauch × 2", note: "Schlauch oder tubeless-kompatibel", badge: null },
      { id: "r5", name: "CO2-Kartuschen × 2 + Adapter", note: "Schnellreparatur unterwegs", badge: null },
      { id: "r6", name: "Flickzeug / Reifenheber", note: "", badge: null },
      { id: "r7", name: "Ersatz-Schaltauge", note: "Nach dem Erlebnis im Mai — Pflicht!", badge: "warn" },
      { id: "r8", name: "Kettenschloss × 2", note: "Quick-Link passend zu SRAM", badge: null },
      { id: "r9", name: "Kettenöl (mini)", note: "Nass- oder Allwetteröl für 700+ km", badge: null },
      { id: "r10", name: "Multitool", note: "Torx T25, Inbus 3/4/5/6 mm", badge: null },
      { id: "r11", name: "Mini-Pumpe", note: "Reifendruck nach Biwak prüfen", badge: null },
    ]
  },
  {
    id: "taschen",
    icon: "🎒",
    title: "Taschen & Gepäck",
    items: [
      { id: "t1", name: "Cyclite XT Rahmentasche", note: "Hauptspeicher: Essen, Werkzeug, Powerbank", badge: null },
      { id: "t2", name: "Cyclite Oberrohrtasche", note: "Snacks für direkten Zugriff", badge: null },
      { id: "t3", name: "Ortlieb Satteltasche (Arschrakete)", note: "Schlafsetup + Kleidungsreserve", badge: null },
      { id: "t4", name: "USWE Race 2.0 Hydration Pack 2L", note: "Blasenkapazität prüfen, Schlauch dicht?", badge: null },
    ]
  },
  {
    id: "schlaf",
    icon: "🌙",
    title: "Schlaf & Biwak",
    items: [
      { id: "s1", name: "SOL Escape Bivy", note: "Windschutz und Feuchtigkeitsschutz", badge: null },
      { id: "s2", name: "Sea to Summit Ultralight XR Isomatte", note: "Aufblasbar — Ventil prüfen", badge: null },
      { id: "s3", name: "Carinthia Defense Tropen", note: "Komfort bis ~+10°C — bei <8°C nachts Merino-Midlayer einplanen", badge: "warn" },
      { id: "s4", name: "Schlafplatz-Strategie", note: "2–3 Spots vorab per GPX/Google Maps identifizieren", badge: null },
    ]
  },
  {
    id: "kleidung",
    icon: "👕",
    title: "Kleidung",
    items: [
      { id: "k1", name: "Syn Cargobibshorts", note: "Assos Chamois Crème eincremen vor Start", badge: null },
      { id: "k2", name: "Syn Kurzarm Pro Race Trikot", note: "", badge: null },
      { id: "k3", name: "Vanrysel Baselayer", note: "", badge: null },
      { id: "k4", name: "Gore Armlinge", note: "In Oberrohrtasche — schneller Zugriff", badge: null },
      { id: "k5", name: "Gore Beinlinge", note: "", badge: null },
      { id: "k6", name: "Syn Regenjacke", note: "Packsack-Größe prüfen, passt in Trikottasche?", badge: null },
      { id: "k7", name: "Syn Race Handschuhe", note: "", badge: null },
      { id: "k8", name: "Rytzon Merino Socken × 2", note: "Wechselsocken für nach Biwak — Pflicht!", badge: null },
      { id: "k9", name: "Ersatz-Bibshorts", note: "Für nach 1. Biwak — weniger Druckstellen", badge: "tip" },
      { id: "k10", name: "Merino-Midlayer (Longsleeve/Gilet)", note: "Für Biwak-Schlaf bei kühler Nacht", badge: "tip" },
      { id: "k11", name: "Buff", note: "", badge: null },
    ]
  },
  {
    id: "kopf",
    icon: "⛑️",
    title: "Kopf & Augen",
    items: [
      { id: "h1", name: "Abus Wingbreaker Helm", note: "Passform prüfen mit Buff drunter", badge: null },
      { id: "h2", name: "Selbsttönende Sonnenbrille", note: "Nachtfahrt-tauglich?", badge: null },
      { id: "h3", name: "Stirnlampe + Ersatzbatterien", note: "Für Biwak, Notfall, Reparaturen in der Nacht", badge: "tip" },
    ]
  },
  {
    id: "elektronik",
    icon: "⚡",
    title: "Elektronik & Navigation",
    items: [
      { id: "e1", name: "Wahoo GPS-Computer", note: "GPX-Track geladen, Backup auf Handy", badge: null },
      { id: "e2", name: "Wahoo Pulsgurt", note: "Batterie prüfen", badge: null },
      { id: "e3", name: "GPS-Tracker (vom Veranstalter)", note: "Pflicht — beim Riders Briefing abholen", badge: "warn" },
      { id: "e4", name: "Powerbank 20.000 mAh+", note: "Lädt Wahoo, Handy, Licht", badge: null },
      { id: "e5", name: "Ladekabel USB-C × 2", note: "Eines als Backup", badge: null },
      { id: "e6", name: "Frontlicht (800+ Lumen)", note: "Für Nachtfahrten", badge: null },
      { id: "e7", name: "Rücklicht", note: "Mit Dauerlicht-Funktion", badge: null },
      { id: "e8", name: "Handy voll geladen", note: "Offline-Karte geladen (Komoot offline)", badge: null },
    ]
  },
  {
    id: "verpflegung",
    icon: "🍬",
    title: "Verpflegung & Flüssigkeit",
    items: [
      { id: "v1", name: "Fidlock Flaschen × 2 (850ml)", note: "Je 90g Carbs vorgemischt", badge: null },
      { id: "v2", name: "Haribo-Reserve (Oberrohrtasche)", note: "~400g für erste Etappe", badge: null },
      { id: "v3", name: "Riegel × 8–10", note: "Für Streckenabschnitte ohne Supermarkt", badge: null },
      { id: "v4", name: "Gels × 5–6 (Notreserve)", note: "Wenn Supermarkt zu hat", badge: "tip" },
      { id: "v5", name: "Salztabletten / Elektrolyte", note: "Ab Stunde 6+ wichtig bei Wärme", badge: "tip" },
      { id: "v6", name: "Assos Chamois Crème (Tube)", note: "Nachcremen bei jedem Biwak!", badge: null },
    ]
  },
  {
    id: "health",
    icon: "🩺",
    title: "Erste Hilfe & Hygiene",
    items: [
      { id: "a1", name: "Mini-Apotheke", note: "Ibuprofen, Pflaster, Blasenpflaster, Desinfektion", badge: null },
      { id: "a2", name: "Sonnencreme SPF 50 (mini)", note: "Norddeutschland im Juni: unterschätzt", badge: "tip" },
      { id: "a3", name: "Zahnbürste + Mini-Zahncreme", note: "Für Biwak — Wohlbefinden-Booster", badge: null },
      { id: "a4", name: "Toilettenpapier (wasserdicht verpackt)", note: "", badge: null },
      { id: "a5", name: "Zip-Beutel × 3 (wasserdicht)", note: "Für Elektronik und Dokumente bei Regen", badge: null },
    ]
  },
  {
    id: "docs",
    icon: "📄",
    title: "Dokumente & Pflicht",
    items: [
      { id: "d1", name: "Personalausweis", note: "", badge: null },
      { id: "d2", name: "Krankenversicherungskarte", note: "", badge: null },
      { id: "d3", name: "Notfallkontakt notiert (am Körper)", note: "Name, Nummer, Blutgruppe", badge: null },
      { id: "d4", name: "Veranstalter-Notfallnummer gespeichert", note: "Für DNF-Meldung per WhatsApp", badge: null },
      { id: "d5", name: "Bargeld ~50€", note: "Nicht alle Läden haben Kartenzahlung", badge: null },
    ]
  },
];

const STORAGE_KEY = "backyard-2026-checklist";

export default function App() {
  const [sections, setSections] = useState(DEFAULT_SECTIONS);
  const [checked, setChecked] = useState({});
  const [loaded, setLoaded] = useState(false);
  const [addingTo, setAddingTo] = useState(null);
  const [newItemName, setNewItemName] = useState("");
  const [newItemNote, setNewItemNote] = useState("");
  const [filter, setFilter] = useState("all");
  const inputRef = useRef(null);

  useEffect(() => {
    async function load() {
      try {
        const r = await window.storage.get(STORAGE_KEY);
        if (r && r.value) {
          const saved = JSON.parse(r.value);
          if (saved.checked) setChecked(saved.checked);
          if (saved.customSections) {
            setSections(prev => {
              const merged = [...DEFAULT_SECTIONS];
              saved.customSections.forEach(cs => {
                const idx = merged.findIndex(s => s.id === cs.id);
                if (idx >= 0) merged[idx] = { ...merged[idx], items: cs.items };
              });
              return merged;
            });
          }
        }
      } catch (e) {}
      setLoaded(true);
    }
    load();
  }, []);

  async function save(newChecked, newSections) {
    const customSections = (newSections || sections).map(s => ({ id: s.id, items: s.items }));
    try {
      await window.storage.set(STORAGE_KEY, JSON.stringify({ checked: newChecked || checked, customSections }));
    } catch (e) {}
  }

  function toggle(itemId) {
    const next = { ...checked, [itemId]: !checked[itemId] };
    setChecked(next);
    save(next, null);
  }

  function addItem(sectionId) {
    if (!newItemName.trim()) return;
    const uid = "custom-" + Date.now();
    const newItem = { id: uid, name: newItemName.trim(), note: newItemNote.trim(), badge: null, custom: true };
    const next = sections.map(s => s.id === sectionId ? { ...s, items: [...s.items, newItem] } : s);
    setSections(next);
    setAddingTo(null);
    setNewItemName("");
    setNewItemNote("");
    save(null, next);
  }

  function deleteItem(sectionId, itemId) {
    const next = sections.map(s => s.id === sectionId ? { ...s, items: s.items.filter(i => i.id !== itemId) } : s);
    setSections(next);
    const nextChecked = { ...checked };
    delete nextChecked[itemId];
    setChecked(nextChecked);
    save(nextChecked, next);
  }

  function resetAll() {
    setChecked({});
    save({}, null);
  }

  const allItems = sections.flatMap(s => s.items);
  const checkedCount = allItems.filter(i => checked[i.id]).length;
  const total = allItems.length;
  const pct = total ? Math.round(checkedCount / total * 100) : 0;

  if (!loaded) return <div style={{ padding: "2rem", color: "#888", fontSize: 14 }}>Lade Packliste…</div>;

  const accentColor = "#E8500A";

  return (
    <div style={{ fontFamily: "'Helvetica Neue', Arial, sans-serif", maxWidth: 640, margin: "0 auto", padding: "1.5rem 1rem" }}>

      {/* Header */}
      <div style={{ marginBottom: "1.5rem" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
          <div>
            <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: accentColor }}>Hamburg's Backyard Ultra</span>
            <h1 style={{ fontSize: 22, fontWeight: 700, margin: "2px 0 0", color: "#111", lineHeight: 1.2 }}>Packliste 2026</h1>
          </div>
          <span style={{ fontSize: 28, fontWeight: 700, color: pct === 100 ? "#1a7a3c" : accentColor }}>{pct}%</span>
        </div>

        {/* Progress */}
        <div style={{ background: "#eee", borderRadius: 99, height: 6, margin: "10px 0 6px", overflow: "hidden" }}>
          <div style={{ width: pct + "%", height: "100%", borderRadius: 99, background: pct === 100 ? "#1a7a3c" : accentColor, transition: "width 0.3s" }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "#888" }}>{checkedCount} von {total} Punkten erledigt</span>
          <button onClick={resetAll} style={{ fontSize: 11, color: "#aaa", background: "none", border: "none", cursor: "pointer", padding: "2px 6px" }}>↺ Reset</button>
        </div>
      </div>

      {/* Filter */}
      <div style={{ display: "flex", gap: 6, marginBottom: "1.5rem" }}>
        {["all", "open", "done"].map(f => (
          <button key={f} onClick={() => setFilter(f)} style={{
            fontSize: 12, padding: "5px 12px", borderRadius: 99, cursor: "pointer", fontWeight: 500,
            border: "1px solid " + (filter === f ? accentColor : "#ddd"),
            background: filter === f ? accentColor : "transparent",
            color: filter === f ? "#fff" : "#666",
            transition: "all 0.15s"
          }}>
            {f === "all" ? "Alle" : f === "open" ? "Offen" : "Erledigt"}
          </button>
        ))}
      </div>

      {/* Sections */}
      {sections.map(section => {
        const visible = section.items.filter(item => {
          if (filter === "open") return !checked[item.id];
          if (filter === "done") return checked[item.id];
          return true;
        });
        if (visible.length === 0 && addingTo !== section.id) return null;
        const sectionDone = section.items.filter(i => checked[i.id]).length;
        const sectionAll = section.items.length;

        return (
          <div key={section.id} style={{ marginBottom: "1.75rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, paddingBottom: 6, borderBottom: "1.5px solid #f0f0f0", marginBottom: 4 }}>
              <span style={{ fontSize: 15 }}>{section.icon}</span>
              <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "#333" }}>{section.title}</span>
              <span style={{ fontSize: 11, color: "#bbb", marginLeft: "auto" }}>{sectionDone}/{sectionAll}</span>
            </div>

            {visible.map(item => (
              <div
                key={item.id}
                style={{
                  display: "flex", alignItems: "flex-start", gap: 10, padding: "7px 4px",
                  borderRadius: 6, cursor: "pointer", opacity: checked[item.id] ? 0.4 : 1,
                  transition: "opacity 0.15s"
                }}
              >
                <div
                  onClick={() => toggle(item.id)}
                  style={{
                    width: 20, height: 20, minWidth: 20, borderRadius: 5, marginTop: 1,
                    border: "1.5px solid " + (checked[item.id] ? "#1a7a3c" : "#ccc"),
                    background: checked[item.id] ? "#1a7a3c" : "transparent",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    transition: "all 0.15s", cursor: "pointer"
                  }}
                >
                  {checked[item.id] && <span style={{ color: "#fff", fontSize: 12, fontWeight: 700, lineHeight: 1 }}>✓</span>}
                </div>
                <div style={{ flex: 1 }} onClick={() => toggle(item.id)}>
                  <div style={{ fontSize: 14, color: "#111", fontWeight: 500, textDecoration: checked[item.id] ? "line-through" : "none" }}>{item.name}</div>
                  {item.note && <div style={{ fontSize: 12, color: "#999", marginTop: 2, lineHeight: 1.4 }}>{item.note}</div>}
                  {item.badge === "warn" && <span style={{ display: "inline-block", fontSize: 11, padding: "2px 7px", borderRadius: 99, background: "#FEF3C7", color: "#92400E", fontWeight: 600, marginTop: 3 }}>⚠ Achtung</span>}
                  {item.badge === "tip" && <span style={{ display: "inline-block", fontSize: 11, padding: "2px 7px", borderRadius: 99, background: "#EFF6FF", color: "#1D4ED8", fontWeight: 600, marginTop: 3 }}>+ Empfehlung</span>}
                </div>
                {item.custom && (
                  <button onClick={() => deleteItem(section.id, item.id)} style={{
                    background: "none", border: "none", cursor: "pointer", fontSize: 14, color: "#ccc",
                    padding: "0 4px", lineHeight: 1, alignSelf: "center"
                  }} title="Löschen">×</button>
                )}
              </div>
            ))}

            {/* Add form */}
            {addingTo === section.id ? (
              <div style={{ marginTop: 8, padding: "10px 12px", background: "#fafafa", borderRadius: 8, border: "1px solid #eee" }}>
                <input
                  ref={inputRef}
                  value={newItemName}
                  onChange={e => setNewItemName(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") addItem(section.id); if (e.key === "Escape") { setAddingTo(null); setNewItemName(""); setNewItemNote(""); } }}
                  placeholder="Bezeichnung..."
                  style={{ width: "100%", fontSize: 13, padding: "6px 8px", border: "1px solid #ddd", borderRadius: 6, marginBottom: 6, outline: "none" }}
                />
                <input
                  value={newItemNote}
                  onChange={e => setNewItemNote(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") addItem(section.id); if (e.key === "Escape") { setAddingTo(null); setNewItemName(""); setNewItemNote(""); } }}
                  placeholder="Notiz (optional)..."
                  style={{ width: "100%", fontSize: 13, padding: "6px 8px", border: "1px solid #ddd", borderRadius: 6, marginBottom: 8, outline: "none" }}
                />
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={() => addItem(section.id)} style={{ fontSize: 12, padding: "5px 14px", background: accentColor, color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600 }}>Hinzufügen</button>
                  <button onClick={() => { setAddingTo(null); setNewItemName(""); setNewItemNote(""); }} style={{ fontSize: 12, padding: "5px 10px", background: "none", color: "#888", border: "1px solid #ddd", borderRadius: 6, cursor: "pointer" }}>Abbrechen</button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => { setAddingTo(section.id); setTimeout(() => inputRef.current?.focus(), 50); }}
                style={{ fontSize: 12, color: "#bbb", background: "none", border: "none", cursor: "pointer", padding: "4px 4px", marginTop: 2, display: "flex", alignItems: "center", gap: 4 }}
              >
                <span style={{ fontSize: 16, lineHeight: 1 }}>+</span> Eigenes hinzufügen
              </button>
            )}
          </div>
        );
      })}

      <div style={{ marginTop: "2rem", paddingTop: "1rem", borderTop: "1px solid #f0f0f0", fontSize: 11, color: "#bbb", textAlign: "center" }}>
        Start: 25. Juni 2026, 07:00 Uhr · Cutoff: 28. Juni 2026, 17:00 Uhr · 700 km · 2.807 hm
      </div>
    </div>
  );
}
