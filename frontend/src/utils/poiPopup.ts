// ---------------------------------------------------------------------------
// Safe Leaflet popup construction for POI markers.
//
// SECURITY: `name`, `description`, and every OSM tag value (address, opening
// hours, phone, website, …) rendered here originate from Overpass (OSM) data —
// an untrusted, publicly-editable, third-party source — or from a saved
// route's own POI markers (still arbitrary user/import-provided text). They
// must NEVER be interpolated into an HTML string and handed to
// `marker.bindPopup()`: OSM tags routinely contain `<`, `"`, and (from a
// malicious edit) full markup, so string interpolation is a direct stored-XSS
// vector against anyone who opens the popup. Leaflet's `bindPopup()` accepts
// a real DOM node, so every value here is set via `textContent` (never
// `innerHTML`) and every link's `href` is validated through `new URL()` with
// an http(s)-only protocol allowlist before being assigned as a DOM property
// (never string-interpolated into an `href="..."` attribute, which — unlike
// the `.href` property — can be broken out of with a crafted value).
// ---------------------------------------------------------------------------

import type { CategoryConfig } from './poiCategories';

export interface PoiPopupTags {
  [key: string]: string | undefined;
}

export interface PoiPopupData {
  name: string;
  description?: string | null;
  category?: CategoryConfig | null;
  address?: string | null;
  openingHours?: string | null;
  phone?: string | null;
  website?: string | null;
}

/** True only for a same-scheme-safe, browser-navigable link — blocks
 *  `javascript:`, `data:`, `vbscript:`, and any other non-http(s) scheme an
 *  attacker-controlled OSM `website`/`contact:website` tag might carry. */
function safeHttpUrl(raw: string): string | null {
  try {
    const u = new URL(raw, window.location.href);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
    return null;
  } catch {
    return null;
  }
}

/** Build a Leaflet-tooltip-ready DOM node for a plain-text label (e.g. a
 *  search-result pin's tooltip). `text` is untrusted third-party data (a
 *  Nominatim `display_name`) — Leaflet's tooltip internals do
 *  `node.innerHTML = content` when `content` is a `string`, but append it as
 *  a DOM node (no HTML parsing) when it's an `HTMLElement`, so passing this
 *  element to `bindTooltip()`/`setTooltipContent()` instead of a raw string
 *  is what actually closes the XSS path — see leaflet-src.js's
 *  `_updateContent()`. */
export function buildSafeTooltipElement(text: string): HTMLDivElement {
  const el = document.createElement('div');
  el.textContent = text; // never innerHTML — see module header
  return el;
}

function row(text: string, opts?: { small?: boolean }): HTMLDivElement {
  const div = document.createElement('div');
  div.style.fontSize = opts?.small ? '11px' : '13px';
  div.style.color = opts?.small ? 'var(--color-text-tertiary)' : 'var(--color-text-primary)';
  div.style.marginBottom = '4px';
  div.textContent = text; // never innerHTML — see module header
  return div;
}

/** Build a Leaflet-popup-ready DOM node for a POI marker. Every dynamic value
 *  is untrusted (OSM/Overpass data or saved-route text) and is set exclusively
 *  via `textContent`/validated DOM properties — never string-built HTML. */
export function buildPoiPopupElement(data: PoiPopupData): HTMLDivElement {
  const container = document.createElement('div');
  container.style.fontFamily = 'Inter, sans-serif';
  container.style.minWidth = '160px';
  container.style.maxWidth = '240px';

  if (data.category) {
    const badgeWrap = document.createElement('div');
    badgeWrap.style.display = 'flex';
    badgeWrap.style.alignItems = 'center';
    badgeWrap.style.gap = '6px';
    badgeWrap.style.marginBottom = '8px';

    const badge = document.createElement('span');
    badge.style.background = data.category.bg;
    badge.style.color = data.category.fg;
    badge.style.borderRadius = '5px';
    badge.style.padding = '2px 7px';
    badge.style.fontSize = '10px';
    badge.style.fontWeight = '700';
    badge.style.fontFamily = "'Hanken Grotesk', sans-serif";
    badge.style.whiteSpace = 'nowrap';
    badge.textContent = data.category.label; // app-defined label, not user data — still textContent for consistency

    badgeWrap.appendChild(badge);
    container.appendChild(badgeWrap);
  }

  const title = document.createElement('div');
  title.style.fontSize = '13px';
  title.style.fontWeight = '700';
  title.style.color = 'var(--color-text-primary)';
  title.style.fontFamily = "'Hanken Grotesk', sans-serif";
  title.style.marginBottom = '6px';
  title.textContent = data.name;
  container.appendChild(title);

  if (data.description) container.appendChild(row(String(data.description), { small: true }));
  if (data.address) container.appendChild(row(`\u{1F4CD} ${data.address}`, { small: true }));
  if (data.openingHours) container.appendChild(row(`\u{1F550} ${data.openingHours}`, { small: true }));
  if (data.phone) container.appendChild(row(`\u{1F4DE} ${data.phone}`, { small: true }));

  if (data.website) {
    const safeUrl = safeHttpUrl(data.website);
    if (safeUrl) {
      const linkWrap = document.createElement('div');
      linkWrap.style.fontSize = '11px';
      linkWrap.style.marginTop = '4px';
      const a = document.createElement('a');
      a.href = safeUrl; // set as a DOM property on a validated http(s) URL — never string-interpolated
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.style.color = 'var(--color-primary)';
      a.style.textDecoration = 'none';
      a.textContent = '\u{1F310} Website';
      linkWrap.appendChild(a);
      container.appendChild(linkWrap);
    }
    // An unsafe/unparseable website value is silently dropped — never surfaced as a clickable link.
  }

  return container;
}
