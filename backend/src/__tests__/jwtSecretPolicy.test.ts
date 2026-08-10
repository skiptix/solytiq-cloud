// ---------------------------------------------------------------------------
// S3 — JWT_SECRET startup policy (auth.ts). The placeholder-string check
// alone let a trivially weak secret ("x", "12345") pass silently as long as
// it wasn't one of the 3 hardcoded known placeholders; auth.ts now also
// enforces a minimum length and a minimum character-variety floor.
//
// Each case dynamically re-imports auth.ts under a fresh Vitest module
// registry (`vi.resetModules()`) with NODE_ENV=production and a specific
// JWT_SECRET, since the check runs once at module-load time.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;

afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
  vi.resetModules();
});

async function importAuthWith(secret: string | undefined): Promise<{ threw: boolean; message?: string }> {
  vi.resetModules();
  process.env.NODE_ENV = 'production';
  if (secret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = secret;
  try {
    await import('../auth');
    return { threw: false };
  } catch (err) {
    return { threw: true, message: (err as Error).message };
  }
}

describe('JWT_SECRET production startup policy', () => {
  it('rejects the three known placeholder secrets', async () => {
    for (const placeholder of ['changeme-secret', 'change_this_secret_in_production', 'solytiq_secret']) {
      const result = await importAuthWith(placeholder);
      expect(result.threw).toBe(true);
    }
  });

  it('rejects a missing secret', async () => {
    const result = await importAuthWith(undefined);
    expect(result.threw).toBe(true);
  });

  it('rejects a short-but-not-a-known-placeholder secret (the pre-fix gap)', async () => {
    // Before the length check existed, this exact value passed the startup
    // check outright and would have been brute-forceable offline against any
    // captured token.
    const result = await importAuthWith('x');
    expect(result.threw).toBe(true);
    expect(result.message).toMatch(/at least \d+ characters/);
  });

  it('rejects a 31-character secret (one below the 32-char floor)', async () => {
    const result = await importAuthWith('a'.repeat(31));
    expect(result.threw).toBe(true);
  });

  it('rejects a 32-character secret with too little character variety', async () => {
    const result = await importAuthWith('a'.repeat(32));
    expect(result.threw).toBe(true);
    expect(result.message).toMatch(/character variety/);
  });

  it('accepts a real random 64-hex-char secret (openssl rand -hex 32 shape)', async () => {
    const result = await importAuthWith('f'.repeat(2) + '3a9c1e7b5d2f4681a0c9e8b7d6f5a4c31029384756afbecd1234567890abcd');
    expect(result.threw).toBe(false);
  });

  it('is NOT enforced outside production (dev/test stays unblocked with the fallback secret)', async () => {
    vi.resetModules();
    process.env.NODE_ENV = 'development';
    delete process.env.JWT_SECRET;
    await expect(import('../auth')).resolves.toBeDefined();
  });
});
