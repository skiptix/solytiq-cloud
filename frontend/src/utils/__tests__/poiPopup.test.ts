// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// S1 — Leaflet/OSM popup XSS fix. Before buildPoiPopupElement existed, POI
// popups (frontend/src/screens/GPSScreen.tsx) were built by interpolating
// untrusted Overpass/OSM tag values (name, address, opening hours, phone,
// website) directly into an HTML string handed to Leaflet's bindPopup() —
// including an entirely unescaped `href="${...}"` attribute for the website
// link. This is a real, publicly-editable third-party data source, so any
// value here can contain markup or an injected attribute/event handler.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import { buildPoiPopupElement, buildSafeTooltipElement } from '../poiPopup';

describe('buildPoiPopupElement (S1 XSS fix)', () => {
  it('renders a malicious name as literal text, not markup — no injected element or handler runs', () => {
    const payload = '<img src=x onerror=alert(1)>';
    const el = buildPoiPopupElement({ name: payload });
    // The payload must appear as plain rendered text somewhere in the tree...
    expect(el.textContent).toContain(payload);
    // ...and NEVER as an actual injected <img> element — onerror-based XSS
    // requires a REAL img element to exist in the DOM (to fire the load-error
    // event); text content that merely spells the same characters, safely
    // HTML-entity-escaped by the browser's own serializer, never executes.
    expect(el.querySelector('img')).toBeNull();
    expect(el.innerHTML).not.toContain('<img'); // only the escaped &lt;img is present
  });

  it('renders a malicious description as literal text', () => {
    const payload = '<script>alert(document.cookie)</script>';
    const el = buildPoiPopupElement({ name: 'Café', description: payload });
    expect(el.textContent).toContain(payload);
    expect(el.querySelector('script')).toBeNull();
  });

  it('renders malicious address/openingHours/phone fields as literal text', () => {
    const el = buildPoiPopupElement({
      name: 'Café',
      address: '<svg onload=alert(1)>',
      openingHours: '"><script>alert(2)</script>',
      phone: '</div><b>injected</b>',
    });
    expect(el.querySelector('svg')).toBeNull();
    expect(el.querySelector('script')).toBeNull();
    // The literal "<b>injected</b>" string must show up as TEXT, not as a
    // real bold element the browser would render/execute context for.
    expect(el.textContent).toContain('injected');
    expect(el.querySelectorAll('b').length).toBe(0);
  });

  it('accepts and links a genuine https website', () => {
    const el = buildPoiPopupElement({ name: 'Café', website: 'https://example.com/menu' });
    const a = el.querySelector('a');
    expect(a).not.toBeNull();
    expect(a!.href).toBe('https://example.com/menu');
    expect(a!.rel).toContain('noopener');
    expect(a!.rel).toContain('noreferrer');
  });

  it('DROPS a javascript: URL website value — never rendered as a clickable link', () => {
    const el = buildPoiPopupElement({ name: 'Café', website: 'javascript:alert(document.cookie)' });
    expect(el.querySelector('a')).toBeNull();
  });

  it('DROPS a javascript: URL with case/whitespace tricks (jAvAsCript:, leading tab)', () => {
    for (const payload of ['jAvAsCript:alert(1)', '\tjavascript:alert(1)', '  javascript:alert(1)', 'JAVASCRIPT:alert(1)']) {
      const el = buildPoiPopupElement({ name: 'Café', website: payload });
      expect(el.querySelector('a'), `payload: ${JSON.stringify(payload)}`).toBeNull();
    }
  });

  it('DROPS a data: URL website value', () => {
    const el = buildPoiPopupElement({ name: 'Café', website: 'data:text/html,<script>alert(1)</script>' });
    expect(el.querySelector('a')).toBeNull();
  });

  it('DROPS a vbscript: URL website value', () => {
    const el = buildPoiPopupElement({ name: 'Café', website: 'vbscript:msgbox(1)' });
    expect(el.querySelector('a')).toBeNull();
  });

  it('never throws on a garbage website value — worst case it resolves as a same-origin relative link, never a dangerous scheme', () => {
    // `new URL(x, base)` almost always resolves SOMETHING against a base
    // (garbage becomes a relative path segment); the meaningful guarantee is
    // not "rejects garbage" but "can never produce anything other than a
    // safe http(s) link, and never crashes" — covered by the two cases above
    // and this one.
    expect(() => buildPoiPopupElement({ name: 'Café', website: '://' })).not.toThrow();
    const el = buildPoiPopupElement({ name: 'Café', website: '://' });
    const a = el.querySelector('a');
    if (a) expect(['http:', 'https:']).toContain(a.protocol);
  });

  it('a bare-word website value resolves as a same-origin RELATIVE path (still http/https, never javascript:) — not an XSS vector', () => {
    const el = buildPoiPopupElement({ name: 'Café', website: 'not a url at all' });
    const a = el.querySelector('a');
    expect(a).not.toBeNull();
    expect(['http:', 'https:']).toContain(a!.protocol);
  });

  it('accepts a protocol-relative website (resolves to a real http(s) link — not an XSS vector)', () => {
    const el = buildPoiPopupElement({ name: 'Café', website: '//example.com/menu' });
    const a = el.querySelector('a');
    expect(a).not.toBeNull();
    expect(['http:', 'https:']).toContain(a!.protocol);
    expect(a!.hostname).toBe('example.com');
  });

  it('a legitimate name/description with no special characters renders normally', () => {
    const el = buildPoiPopupElement({ name: 'Café Central', description: 'Great coffee & pastries' });
    expect(el.textContent).toContain('Café Central');
    expect(el.textContent).toContain('Great coffee & pastries');
  });
});

describe('buildSafeTooltipElement (S1 XSS fix — search-pin tooltip, GPSScreen/GPSEditScreen)', () => {
  it('renders a malicious Nominatim display_name as literal text, never as a real injected element', () => {
    const payload = '<img src=x onerror=alert(1)>';
    const el = buildSafeTooltipElement(payload);
    expect(el.textContent).toBe(payload);
    expect(el.querySelector('img')).toBeNull();
    expect(el.innerHTML).not.toContain('<img');
  });

  it('is an HTMLElement (not a string) — the actual mechanism that keeps Leaflet off its innerHTML-assignment path', () => {
    const el = buildSafeTooltipElement('anything');
    expect(el).toBeInstanceOf(HTMLElement);
  });

  it('a legitimate place name renders normally', () => {
    const el = buildSafeTooltipElement('Café Central, Berlin, Germany');
    expect(el.textContent).toBe('Café Central, Berlin, Germany');
  });
});
