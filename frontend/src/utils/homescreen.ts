// Detects the iOS "Add to Home Screen" standalone launch mode and manages a
// locally-persisted install id, so repeat opens from the same Home Screen
// icon are tracked in Account Settings as one device rather than a new one
// every launch (see backend/src/routes/auth.ts's homescreen-connections
// routes and CLAUDE.md's "Home Screen Install" section).
import { genId } from './id';

const INSTALL_ID_KEY = 'solytiq_homescreen_install_id';

export function isHomeScreenApp(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
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

// Best-effort device label + iOS version parsed from the UA string — the web
// platform gives no richer device info (no exact model) from a browser tab.
export function detectHomeScreenDevice(): { deviceName: string; osVersion: string | null } {
  const ua = window.navigator.userAgent;
  const deviceName = /iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /iPod/.test(ua) ? 'iPod touch' : 'Home Screen App';
  const match = ua.match(/OS (\d+)_(\d+)(?:_(\d+))?/);
  const osVersion = match ? `iOS ${match[1]}.${match[2]}${match[3] ? `.${match[3]}` : ''}` : null;
  return { deviceName, osVersion };
}
