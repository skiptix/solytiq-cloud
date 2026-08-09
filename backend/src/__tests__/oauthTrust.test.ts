// ---------------------------------------------------------------------------
// S3 — OAuth consent-phishing fix: `isTrustedRedirectUri` is the ONE signal
// the consent screen uses to decide whether to say "Claude" (see
// OAuthConsentScreen.tsx / GET /oauth/client-info) — it must be impossible
// for a self-registered client to spoof, since `client_name` itself is
// attacker-controlled free text accepted by unauthenticated DCR
// (POST /oauth/register).
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it } from 'vitest';
import { isTrustedRedirectUri, trustedRedirectHosts } from '../routes/oauth';

const ORIGINAL_HOSTS = process.env.OAUTH_TRUSTED_REDIRECT_HOSTS;
afterEach(() => { process.env.OAUTH_TRUSTED_REDIRECT_HOSTS = ORIGINAL_HOSTS; });

describe('isTrustedRedirectUri (S3 consent-phishing guard)', () => {
  it('defaults to trusting claude.ai and claude.com', () => {
    delete process.env.OAUTH_TRUSTED_REDIRECT_HOSTS;
    expect(trustedRedirectHosts()).toEqual(['claude.ai', 'claude.com']);
    expect(isTrustedRedirectUri('https://claude.ai/api/mcp/callback')).toBe(true);
    expect(isTrustedRedirectUri('https://claude.com/callback')).toBe(true);
  });

  it('trusts a subdomain of a trusted host', () => {
    delete process.env.OAUTH_TRUSTED_REDIRECT_HOSTS;
    expect(isTrustedRedirectUri('https://api.claude.ai/callback')).toBe(true);
  });

  it('REJECTS an attacker-registered redirect_uri on a lookalike/unrelated domain — the core phishing scenario', () => {
    delete process.env.OAUTH_TRUSTED_REDIRECT_HOSTS;
    // A self-registered client (POST /oauth/register accepts any https
    // redirect_uris — see isValidRedirectUri) claiming to be "Claude" but
    // actually pointing at an attacker's own server.
    expect(isTrustedRedirectUri('https://claude-ai.attacker.example.com/callback')).toBe(false);
    expect(isTrustedRedirectUri('https://not-claude.ai.evil.com/callback')).toBe(false);
    expect(isTrustedRedirectUri('https://evil.example.com/callback')).toBe(false);
  });

  it('does NOT treat a trusted host as a mere substring — "claude.ai.evil.com" must not pass', () => {
    delete process.env.OAUTH_TRUSTED_REDIRECT_HOSTS;
    expect(isTrustedRedirectUri('https://claude.ai.evil.com/callback')).toBe(false);
  });

  it('rejects a malformed redirect_uri rather than throwing', () => {
    delete process.env.OAUTH_TRUSTED_REDIRECT_HOSTS;
    expect(isTrustedRedirectUri('not a url')).toBe(false);
  });

  it('is operator-configurable via OAUTH_TRUSTED_REDIRECT_HOSTS', () => {
    process.env.OAUTH_TRUSTED_REDIRECT_HOSTS = 'my-self-hosted-mcp-client.example.com';
    expect(isTrustedRedirectUri('https://my-self-hosted-mcp-client.example.com/cb')).toBe(true);
    // The operator-configured list REPLACES the default — claude.ai is no
    // longer implicitly trusted once a custom list is set.
    expect(isTrustedRedirectUri('https://claude.ai/callback')).toBe(false);
  });
});
