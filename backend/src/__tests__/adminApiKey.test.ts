import { describe, it, expect } from 'vitest';
import { ADMIN_API_SCOPES, sanitizeScopes, generateAdminApiKey, hashAdminApiKey } from '../adminApiKey';

describe('admin API key scopes', () => {
  it('exposes the expected scope catalogue', () => {
    expect(ADMIN_API_SCOPES).toEqual(['read', 'users', 'workspaces', 'folders', 'lists', 'timelines', 'meetings']);
  });

  it('keeps only valid scopes and de-duplicates', () => {
    expect(sanitizeScopes(['read', 'users', 'users'])).toEqual(['read', 'users']);
    expect(sanitizeScopes(['lists', 'bogus', 42, null])).toEqual(['lists']);
  });

  it('falls back to ["read"] for empty/invalid input', () => {
    expect(sanitizeScopes([])).toEqual(['read']);
    expect(sanitizeScopes(['nope'])).toEqual(['read']);
    expect(sanitizeScopes(undefined)).toEqual(['read']);
    expect(sanitizeScopes('read')).toEqual(['read']); // non-array
  });
});

describe('admin API key generation', () => {
  it('mints a prefixed secret whose hash matches and whose prefix hides the secret', () => {
    const k = generateAdminApiKey();
    expect(k.raw.startsWith('solytiq_admin_')).toBe(true);
    expect(k.hash).toBe(hashAdminApiKey(k.raw));
    expect(k.hash).not.toContain(k.raw);
    expect(k.prefix.endsWith('…')).toBe(true);
    // Two keys are never identical.
    expect(generateAdminApiKey().raw).not.toBe(k.raw);
  });
});
