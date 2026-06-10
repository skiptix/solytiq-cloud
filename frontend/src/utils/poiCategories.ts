import type { PoiCategory } from '../types';

export interface CategoryConfig {
  label: string;
  icon: string;       // Material Symbol name
  bg: string;         // Icon-Background
  fg: string;         // Icon-Farbe
  borderColor: string;
  gpxSym: string;     // GPX <sym> Value (Wahoo-kompatibel)
}

export const POI_CATEGORY_CONFIG: Record<PoiCategory, CategoryConfig> = {
  food: {
    label: 'Café / Restaurant',
    icon: 'local_cafe',
    bg: '#fef3c7',        // amber-tint
    fg: '#92400e',
    borderColor: '#f59e0b',
    gpxSym: 'Restaurant',
  },
  fuel: {
    label: 'Tankstelle',
    icon: 'local_gas_station',
    bg: '#f1f5f9',        // slate-tint
    fg: '#475569',
    borderColor: '#94a3b8',
    gpxSym: 'Gas Station',
  },
  bicycle: {
    label: 'Fahrradladen',
    icon: 'pedal_bike',
    bg: '#ede9ff',        // Solytiq lavender-tint
    fg: '#5e4dbb',
    borderColor: '#c4b8f0',
    gpxSym: 'Bike Shop',
  },
  shopping: {
    label: 'Supermarkt',
    icon: 'local_grocery_store',
    bg: '#dcfce7',        // green-tint
    fg: '#166534',
    borderColor: '#86efac',
    gpxSym: 'Grocery Store',
  },
  kiosk: {
    label: 'Kiosk',
    icon: 'storefront',
    bg: '#e0f2fe',        // sky-tint
    fg: '#0369a1',
    borderColor: '#7dd3fc',
    gpxSym: 'Convenience Store',
  },
};

// sym → GPX-Wert Mapping (für Named Pins, nicht nur POI-Kategorien)
export const SYM_TO_GPX: Record<string, string> = {
  food: 'Restaurant',
  fuel: 'Gas Station',
  bicycle: 'Bike Shop',
  shopping: 'Grocery Store',
  kiosk: 'Convenience Store',
  flag: 'Flag',
  generic: 'Waypoint',
};

// Erstellt ein Leaflet DivIcon für einen POI-Marker
// Nutzt die global geladene Material Symbols Schriftart
export function createPoiDivIcon(category: PoiCategory, size = 28): string {
  const cfg = POI_CATEGORY_CONFIG[category];
  return `
    <div style="
      width:${size}px;height:${size}px;
      border-radius:${Math.round(size * 0.3)}px;
      background:${cfg.bg};
      border:1.5px solid ${cfg.borderColor};
      display:flex;align-items:center;justify-content:center;
      box-shadow:0 2px 8px rgba(0,0,0,0.18);
      cursor:pointer;
      font-family:'Material Symbols Outlined';
      font-size:${Math.round(size * 0.56)}px;
      color:${cfg.fg};
      line-height:1;
      font-variation-settings:'FILL' 1,'wght' 400;
    ">${cfg.icon}</div>
  `.trim();
}

// Named Pin DivIcon (ähnlich POI, aber mit Pin-Spitze + optionalem Stern)
export function createPinDivIcon(sym: string, highlighted: boolean, size = 30): string {
  const isCat = sym in POI_CATEGORY_CONFIG;
  const cfg = isCat ? POI_CATEGORY_CONFIG[sym as PoiCategory] : null;
  const bg = cfg?.bg ?? '#ede9ff';
  const fg = cfg?.fg ?? '#5e4dbb';
  const border = cfg?.borderColor ?? '#c4b8f0';
  const icon = cfg?.icon ?? 'push_pin';

  const starBadge = highlighted
    ? `<div style="position:absolute;top:-5px;right:-5px;
        width:14px;height:14px;border-radius:50%;
        background:#5e4dbb;border:2px solid #fff;
        display:flex;align-items:center;justify-content:center;
        font-family:'Material Symbols Outlined';font-size:8px;color:#fff;
        font-variation-settings:'FILL' 1,'wght' 400;
        line-height:1;">star</div>`
    : '';

  return `
    <div style="position:relative;width:${size}px;height:${size}px;">
      <div style="
        width:${size}px;height:${size}px;
        border-radius:${Math.round(size * 0.3)}px;
        background:${bg};
        border:2px solid ${border};
        display:flex;align-items:center;justify-content:center;
        box-shadow:0 3px 10px rgba(94,77,187,0.30);
        cursor:pointer;
        font-family:'Material Symbols Outlined';
        font-size:${Math.round(size * 0.53)}px;
        color:${fg};line-height:1;
        font-variation-settings:'FILL' 1,'wght' 400;
      ">${icon}</div>
      ${starBadge}
    </div>
  `.trim();
}
