import { describe, it, expect } from 'vitest';
import { generateInvitationToken, hashInvitationToken } from '../userInvitations';

describe('userInvitations token helpers', () => {
  it('generates high-entropy, URL-safe tokens that never repeat', () => {
    const a = generateInvitationToken();
    const b = generateInvitationToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(32);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('hashes deterministically, so a re-derived hash matches a stored one', () => {
    const raw = generateInvitationToken();
    expect(hashInvitationToken(raw)).toBe(hashInvitationToken(raw));
  });

  it('produces a 64-char hex SHA-256 digest that never contains the raw token', () => {
    const raw = generateInvitationToken();
    const hash = hashInvitationToken(raw);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain(raw);
  });

  it('a single-character difference in the raw token produces a completely different hash', () => {
    const raw = generateInvitationToken();
    const tampered = raw.slice(0, -1) + (raw.at(-1) === 'a' ? 'b' : 'a');
    expect(hashInvitationToken(raw)).not.toBe(hashInvitationToken(tampered));
  });
});
