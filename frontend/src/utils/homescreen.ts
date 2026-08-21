// Detects a standalone-launched web app — iOS "Add to Home Screen", a macOS
// Chrome/Edge/Chromium PWA install, or Safari's macOS Sonoma+ "Add to Dock"
// — and manages a locally-persisted install id, so repeat opens from the
// same icon are tracked in Account Settings as one device rather than a new
// one every launch (see backend/src/routes/auth.ts's homescreen-connections
// routes and CLAUDE.md's "Home Screen Install" section).
import { genId } from './id';

const INSTALL_ID_KEY = 'solytiq_homescreen_install_id';

export function isHomeScreenApp(): boolean {
  return (
    // Fires for any installed PWA (Chrome/Edge/Chromium on any desktop OS,
    // Safari macOS "Add to Dock") as well as iOS Home Screen launches.
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS-only fallback for the rare case display-mode isn't reported yet.
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

export function getOrCreateInstallId(): string {
  let id = localStorage.getItem(INSTALL_ID_KEY);
  if (!id) {
    id = genId('hs');
    localStorage.setItem(INSTALL_ID_KEY, id);
  }
  return id;
}

// Best-effort browser identification on macOS. Desktop browsers now freeze
// or omit the precise OS build number in the UA string for privacy (Chrome's
// User-Agent Reduction, Safari's long-standing 10_15_7 placeholder), so a
// real macOS version is not reliably recoverable — the browser identity is
// the useful, reliable signal instead. Order matters: Edge/Opera/Chrome UAs
// all also contain "Safari/...", so those must be checked first.
function detectMacBrowser(ua: string): string {
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\//.test(ua)) return 'Opera';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\//.test(ua) || /Chromium\//.test(ua)) return 'Chrome';
  if (/Version\//.test(ua) && /Safari\//.test(ua)) return 'Safari';
  return 'Browser';
}

// Best-effort device label + OS version parsed from the UA string — the web
// platform gives no richer device info (no exact model) from a browser tab.
export function detectHomeScreenDevice(): { deviceName: string; osVersion: string | null } {
  const ua = window.navigator.userAgent;

  if (/iPad|iPhone|iPod/.test(ua)) {
    const deviceName = /iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : 'iPod touch';
    const match = ua.match(/OS (\d+)_(\d+)(?:_(\d+))?/);
    const osVersion = match ? `iOS ${match[1]}.${match[2]}${match[3] ? `.${match[3]}` : ''}` : null;
    return { deviceName, osVersion };
  }

  if (/Macintosh|Mac OS X/.test(ua)) {
    return { deviceName: `Mac (${detectMacBrowser(ua)})`, osVersion: 'macOS' };
  }

  return { deviceName: 'Home Screen App', osVersion: null };
}
