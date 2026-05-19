import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const DEFAULT_SECTIONS = [
  {
    icon: "🚴",
    title: "Rad & Antrieb",
    items: [
      { name: "Stevens Camino Pro AXS", note: "SRAM Force AXS, 44/10-44 — Schaltwerk prüfen", badge: null },
      { name: "Aerobars montiert & eingestellt", note: "Armlageposition for 10h+ testen", badge: null },
      { name: "Vittoria Terreno Dry 45mm", note: "Reifendruck prüfen, empfohlen 3.0–3.5 bar", badge: null },
      { name: "Ersatzschlauch × 2", note: "Schlauch oder tubeless-kompatibel", badge: null },
      { name: "CO2-Kartuschen × 2 + Adapter", note: "Schnellreparatur unterwegs", badge: null },
      { name: "Flickzeug / Reifenheber", note: "", badge: null },
      { name: "Ersatz-Schaltauge", note: "Nach dem Erlebnis im Mai — Pflicht!", badge: "warn" },
      { name: "Kettenschloss × 2", note: "Quick-Link passend zu SRAM", badge: null },
      { name: "Kettenöl (mini)", note: "Nass- oder Allwetteröl für 700+ km", badge: null },
      { name: "Multitool", note: "Torx T25, Inbus 3/4/5/6 mm", badge: null },
      { name: "Mini-Pumpe", note: "Reifendruck nach Biwak prüfen", badge: null },
    ]
  },
  {
    icon: "🎒",
    title: "Taschen & Gepäck",
    items: [
      { name: "Cyclite XT Rahmentasche", note: "Hauptspeicher: Essen, Werkzeug, Powerbank", badge: null },
      { name: "Cyclite Oberrohrtasche", note: "Snacks für direkten Zugriff", badge: null },
      { name: "Ortlieb Satteltasche (Arschrakete)", note: "Schlafsetup + Kleidungsreserve", badge: null },
      { name: "USWE Race 2.0 Hydration Pack 2L", note: "Blasenkapazität prüfen, Schlauch dicht?", badge: null },
    ]
  },
  {
    icon: "🌙",
    title: "Schlaf & Biwak",
    items: [
      { name: "SOL Escape Bivy", note: "Windschutz und Feuchtigkeitsschutz", badge: null },
      { name: "Sea to Summit Ultralight XR Isomatte", note: "Aufblasbar — Ventil prüfen", badge: null },
      { name: "Carinthia Defense Tropen", note: "Komfort bis ~+10°C — bei <8°C nachts Merino-Midlayer einplanen", badge: "warn" },
      { name: "Schlafplatz-Strategie", note: "2–3 Spots vorab per GPX/Google Maps identifizieren", badge: null },
    ]
  },
  {
    icon: "👕",
    title: "Kleidung",
    items: [
      { name: "Syn Cargobibshorts", note: "Assos Chamois Crème eincremen vor Start", badge: null },
      { name: "Syn Kurzarm Pro Race Trikot", note: "", badge: null },
      { name: "Vanrysel Baselayer", note: "", badge: null },
      { name: "Gore Armlinge", note: "In Oberrohrtasche — schneller Zugriff", badge: null },
      { name: "Gore Beinlinge", note: "", badge: null },
      { name: "Syn Regenjacke", note: "Packsack-Größe prüfen, passt in Trikottasche?", badge: null },
      { name: "Syn Race Handschuhe", note: "", badge: null },
      { name: "Rytzon Merino Socken × 2", note: "Wechselsocken für nach Biwak — Pflicht!", badge: null },
      { name: "Ersatz-Bibshorts", note: "Für nach 1. Biwak — weniger Druckstellen", badge: "tip" },
      { name: "Merino-Midlayer (Longsleeve/Gilet)", note: "Für Biwak-Schlaf bei kühler Nacht", badge: "tip" },
      { name: "Buff", note: "", badge: null },
    ]
  },
  {
    icon: "⛑️",
    title: "Kopf & Augen",
    items: [
      { name: "Abus Wingbreaker Helm", note: "Passform prüfen mit Buff drunter", badge: null },
      { name: "Selbsttönende Sonnenbrille", note: "Nachtfahrt-tauglich?", badge: null },
      { name: "Stirnlampe + Ersatzbatterien", note: "Für Biwak, Notfall, Reparaturen in der Nacht", badge: "tip" },
    ]
  },
  {
    icon: "⚡",
    title: "Elektronik & Navigation",
    items: [
      { name: "Wahoo GPS-Computer", note: "GPX-Track geladen, Backup auf Handy", badge: null },
      { name: "Wahoo Pulsgurt", note: "Batterie prüfen", badge: null },
      { name: "GPS-Tracker (vom Veranstalter)", note: "Pflicht — beim Riders Briefing abholen", badge: "warn" },
      { name: "Powerbank 20.000 mAh+", note: "Lädt Wahoo, Handy, Licht", badge: null },
      { name: "Ladekabel USB-C × 2", note: "Eines als Backup", badge: null },
      { name: "Frontlicht (800+ Lumen)", note: "Für Nachtfahrten", badge: null },
      { name: "Rücklicht", note: "Mit Dauerlicht-Funktion", badge: null },
      { name: "Handy voll geladen", note: "Offline-Karte geladen (Komoot offline)", badge: null },
    ]
  },
  {
    icon: "🍬",
    title: "Verpflegung & Flüssigkeit",
    items: [
      { name: "Fidlock Flaschen × 2 (850ml)", note: "Je 90g Carbs vorgemischt", badge: null },
      { name: "Haribo-Reserve (Oberrohrtasche)", note: "~400g for erste Etappe", badge: null },
      { name: "Riegel × 8–10", note: "Für Streckenabschnitte ohne Supermarkt", badge: null },
      { name: "Gels × 5–6 (Notreserve)", note: "Wenn Supermarkt zu hat", badge: "tip" },
      { name: "Salztabletten / Elektrolyte", note: "Ab Stunde 6+ wichtig bei Wärme", badge: "tip" },
      { name: "Assos Chamois Crème (Tube)", note: "Nachcremen bei jedem Biwak!", badge: null },
    ]
  },
  {
    icon: "🩺",
    title: "Erste Hilfe & Hygiene",
    items: [
      { name: "Mini-Apotheke", note: "Ibuprofen, Pflaster, Blasenpflaster, Desinfektion", badge: null },
      { name: "Sonnencreme SPF 50 (mini)", note: "Norddeutschland im Juni: unterschätzt", badge: "tip" },
      { name: "Zahnbürste + Mini-Zahncreme", note: "Für Biwak — Wohlbefinden-Booster", badge: null },
      { name: "Toilettenpapier (wasserdicht verpackt)", note: "", badge: null },
      { name: "Zip-Beutel × 3 (wasserdicht)", note: "Für Elektronik und Dokumente bei Regen", badge: null },
    ]
  },
  {
    icon: "📄",
    title: "Dokumente & Pflicht",
    items: [
      { name: "Personalausweis", note: "", badge: null },
      { name: "Krankenversicherungskarte", note: "", badge: null },
      { name: "Notfallkontakt notiert (am Körper)", note: "Name, Nummer, Blutgruppe", badge: null },
      { name: "Veranstalter-Notfallnummer gespeichert", note: "Für DNF-Meldung per WhatsApp", badge: null },
      { name: "Bargeld ~50€", note: "Nicht alle Läden haben Kartenzahlung", badge: null },
    ]
  },
];

async function main() {
  console.log("Seeding database...");

  // Seed Countdown
  await prisma.countdown.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      title: "Hamburg's Backyard Ultra 2026",
      date: new Date("2026-06-25T07:00:00"),
    },
  });

  // Seed Sections and Items
  for (let i = 0; i < DEFAULT_SECTIONS.length; i++) {
    const s = DEFAULT_SECTIONS[i];
    const section = await prisma.section.create({
      data: {
        title: s.title,
        icon: s.icon,
        order: i,
      },
    });

    for (let j = 0; j < s.items.length; j++) {
      const item = s.items[j];
      await prisma.item.create({
        data: {
          name: item.name,
          note: item.note,
          badge: item.badge,
          order: j,
          sectionId: section.id,
        },
      });
    }
  }

  console.log("Seeding complete!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
