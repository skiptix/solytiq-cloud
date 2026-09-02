// ---------------------------------------------------------------------------
// The per-platform voice-mode rule.
//
// `resolveVoiceMode` is three lines, and pinning it still earns its keep: the
// product requirement is literally "mobile defaults to voice-only, desktop to
// hybrid, and an explicit choice wins everywhere", and this is the one place
// in the codebase where that sentence is executable. Anything that reverses
// the mobile default — or lets the platform override a choice the user
// actually made — turns Sol into a different product on a phone.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { resolveVoiceMode } from '../useAIStore';

const MOBILE = true;
const DESKTOP = false;

describe('resolveVoiceMode', () => {
  it('defaults a phone to voice-only', () => {
    expect(resolveVoiceMode(null, MOBILE)).toBe('voice');
  });

  it('defaults a desktop to hybrid', () => {
    expect(resolveVoiceMode(null, DESKTOP)).toBe('hybrid');
  });

  it('treats an absent value the same as an explicit null', () => {
    // A backend that predates the column returns undefined, not null. Both
    // mean "no choice stored" and must not be told apart.
    expect(resolveVoiceMode(undefined, MOBILE)).toBe('voice');
    expect(resolveVoiceMode(undefined, DESKTOP)).toBe('hybrid');
  });

  it('honours an explicit choice on every platform, including against the default', () => {
    // This is what makes choosing mean something: picking hybrid must survive
    // opening the app on a phone, and picking voice must survive a laptop.
    expect(resolveVoiceMode('hybrid', MOBILE)).toBe('hybrid');
    expect(resolveVoiceMode('voice', DESKTOP)).toBe('voice');
    expect(resolveVoiceMode('hybrid', DESKTOP)).toBe('hybrid');
    expect(resolveVoiceMode('voice', MOBILE)).toBe('voice');
  });

  it('never resolves to anything but one of the two real modes', () => {
    for (const stored of [null, undefined, 'hybrid', 'voice'] as const) {
      for (const mobile of [MOBILE, DESKTOP]) {
        expect(['hybrid', 'voice']).toContain(resolveVoiceMode(stored, mobile));
      }
    }
  });
});
