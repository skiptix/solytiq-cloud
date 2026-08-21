// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { detectHomeScreenDevice } from '../homescreen';

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPAD_UA =
  'Mozilla/5.0 (iPad; CPU OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1';
const MAC_SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const MAC_CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAC_EDGE_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0';
const MAC_FIREFOX_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:124.0) Gecko/20100101 Firefox/124.0';
const WINDOWS_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function withUserAgent(ua: string) {
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
}

describe('detectHomeScreenDevice', () => {
  const originalUA = window.navigator.userAgent;
  afterEach(() => withUserAgent(originalUA));

  it('detects an iPhone with its iOS version', () => {
    withUserAgent(IPHONE_UA);
    expect(detectHomeScreenDevice()).toEqual({ deviceName: 'iPhone', osVersion: 'iOS 17.5' });
  });

  it('detects an iPad with its iOS version', () => {
    withUserAgent(IPAD_UA);
    expect(detectHomeScreenDevice()).toEqual({ deviceName: 'iPad', osVersion: 'iOS 17.4.1' });
  });

  it('labels a Mac + Safari install', () => {
    withUserAgent(MAC_SAFARI_UA);
    expect(detectHomeScreenDevice()).toEqual({ deviceName: 'Mac (Safari)', osVersion: 'macOS' });
  });

  it('labels a Mac + Chrome install', () => {
    withUserAgent(MAC_CHROME_UA);
    expect(detectHomeScreenDevice()).toEqual({ deviceName: 'Mac (Chrome)', osVersion: 'macOS' });
  });

  it('labels a Mac + Edge install as Edge, not Chrome', () => {
    withUserAgent(MAC_EDGE_UA);
    expect(detectHomeScreenDevice()).toEqual({ deviceName: 'Mac (Edge)', osVersion: 'macOS' });
  });

  it('labels a Mac + Firefox install', () => {
    withUserAgent(MAC_FIREFOX_UA);
    expect(detectHomeScreenDevice()).toEqual({ deviceName: 'Mac (Firefox)', osVersion: 'macOS' });
  });

  it('falls back to a generic label off iOS/macOS', () => {
    withUserAgent(WINDOWS_CHROME_UA);
    expect(detectHomeScreenDevice()).toEqual({ deviceName: 'Home Screen App', osVersion: null });
  });
});
