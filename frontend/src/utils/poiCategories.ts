import type { PoiCategory } from '../types';

export interface CategoryConfig {
  label: string;
  icon: string;
  bg: string;
  fg: string;
  borderColor: string;
  gpxSym: string;
}

export const POI_CATEGORY_CONFIG: Record<PoiCategory, CategoryConfig> = {
  food: {
    label: 'Café / Restaurant',
    icon: 'local_cafe',
    bg: 'var(--color-yellow-tint-1)',
    fg: 'var(--color-orange-deep-1)',
    borderColor: 'var(--color-warning-alt)',
    gpxSym: 'Restaurant',
  },
  fuel: {
    label: 'Tankstelle',
    icon: 'local_gas_station',
    bg: 'var(--color-blue-pale-4)',
    fg: 'var(--color-blue-deep-1)',
    borderColor: 'var(--color-blue-mid-1)',
    gpxSym: 'Gas Station',
  },
  bicycle: {
    label: 'Fahrradladen',
    icon: 'pedal_bike',
    bg: 'var(--color-surface-tint-4)',
    fg: 'var(--color-primary)',
    borderColor: 'var(--color-accent-purple-soft)',
    gpxSym: 'Bike Shop',
  },
  shopping: {
    label: 'Supermarkt',
    icon: 'local_grocery_store',
    bg: 'var(--color-green-pale-5)',
    fg: 'var(--color-green-deep-4)',
    borderColor: 'var(--color-green-tint-3)',
    gpxSym: 'Grocery Store',
  },
  kiosk: {
    label: 'Kiosk',
    icon: 'storefront',
    bg: 'var(--color-blue-pale-8)',
    fg: 'var(--color-blue-deep-2)',
    borderColor: 'var(--color-blue-tint-4)',
    gpxSym: 'Convenience Store',
  },
};

export const SYM_TO_GPX: Record<string, string> = {
  food: 'Restaurant',
  fuel: 'Gas Station',
  bicycle: 'Bike Shop',
  shopping: 'Grocery Store',
  kiosk: 'Convenience Store',
  flag: 'Flag',
  generic: 'Waypoint',
};

export function createPoiDivIcon(category: PoiCategory, size = 28): string {
  const cfg = POI_CATEGORY_CONFIG[category];
  return `<div style="width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.3)}px;background:${cfg.bg};border:1.5px solid ${cfg.borderColor};display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(var(--color-black-rgb), 0.18);cursor:pointer;font-family: var(--font-icon);font-size:${Math.round(size * 0.56)}px;color:${cfg.fg};line-height:1;font-variation-settings:'FILL' 1,'wght' 400;">${cfg.icon}</div>`;
}

export function createPinDivIcon(sym: string, highlighted: boolean, size = 30): string {
  const isCat = sym in POI_CATEGORY_CONFIG;
  const cfg = isCat ? POI_CATEGORY_CONFIG[sym as PoiCategory] : null;
  const bg = cfg?.bg ?? 'var(--color-surface-tint-4)';
  const fg = cfg?.fg ?? 'var(--color-primary)';
  const border = cfg?.borderColor ?? 'var(--color-accent-purple-soft)';
  const icon = cfg?.icon ?? 'push_pin';
  const starBadge = highlighted
    ? `<div style="position:absolute;top:-5px;right:-5px;width:14px;height:14px;border-radius:50%;background:var(--color-primary);border:2px solid var(--color-white);display:flex;align-items:center;justify-content:center;font-family: var(--font-icon);font-size:8px;color:var(--color-white);font-variation-settings:'FILL' 1,'wght' 400;line-height:1;">star</div>`
    : '';
  return `<div style="position:relative;width:${size}px;height:${size}px;"><div style="width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.3)}px;background:${bg};border:2px solid ${border};display:flex;align-items:center;justify-content:center;box-shadow:0 3px 10px rgba(var(--color-primary-rgb), 0.30);cursor:pointer;font-family: var(--font-icon);font-size:${Math.round(size * 0.53)}px;color:${fg};line-height:1;font-variation-settings:'FILL' 1,'wght' 400;">${icon}</div>${starBadge}</div>`;
}
