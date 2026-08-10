// ---------------------------------------------------------------------------
// S6 — central upload-size configuration (uploadLimits.ts). Pure env-var
// parsing with safe fallbacks — dynamic re-import per test (vi.resetModules)
// since every export is computed once at module load time from process.env,
// same pattern as jwtSecretPolicy.test.ts.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ENV_KEYS = [
  'FILE_UPLOAD_MAX_BYTES',
  'TASK_ATTACHMENT_MAX_BYTES',
  'MILESTONE_ATTACHMENT_MAX_BYTES',
  'GPS_UPLOAD_MAX_BYTES',
  'MARKDOWN_IMAGE_MAX_BYTES',
  'AI_FILE_UPLOAD_MAX_BYTES',
] as const;

const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  vi.resetModules();
});

describe('uploadLimits defaults (no env overrides)', () => {
  it('matches the exact pre-refactor hardcoded values, so this is a pure extraction with no behavior change', async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    vi.resetModules();
    const mod = await import('../uploadLimits');
    expect(mod.FILE_UPLOAD_MAX_BYTES).toBe(Number.POSITIVE_INFINITY);
    expect(mod.TASK_ATTACHMENT_MAX_BYTES).toBe(200 * 1024 * 1024);
    expect(mod.MILESTONE_ATTACHMENT_MAX_BYTES).toBe(200 * 1024 * 1024);
    expect(mod.GPS_UPLOAD_MAX_BYTES).toBe(50 * 1024 * 1024);
    expect(mod.MARKDOWN_IMAGE_MAX_BYTES).toBe(15 * 1024 * 1024);
    expect(mod.AI_FILE_UPLOAD_MAX_BYTES).toBe(25 * 1024 * 1024);
  });
});

describe('uploadLimits env overrides', () => {
  it('an operator can override any individual limit via its env var', async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.TASK_ATTACHMENT_MAX_BYTES = '1000';
    process.env.GPS_UPLOAD_MAX_BYTES = '2000';
    vi.resetModules();
    const mod = await import('../uploadLimits');
    expect(mod.TASK_ATTACHMENT_MAX_BYTES).toBe(1000);
    expect(mod.GPS_UPLOAD_MAX_BYTES).toBe(2000);
    // Untouched vars still fall back to their documented default.
    expect(mod.MILESTONE_ATTACHMENT_MAX_BYTES).toBe(200 * 1024 * 1024);
  });

  it('falls back to the default for a non-numeric override rather than producing NaN/0', async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.GPS_UPLOAD_MAX_BYTES = 'not-a-number';
    vi.resetModules();
    const mod = await import('../uploadLimits');
    expect(mod.GPS_UPLOAD_MAX_BYTES).toBe(50 * 1024 * 1024);
  });

  it('falls back to the default for a zero or negative override (a multer fileSize of 0 would silently reject every upload)', async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.MARKDOWN_IMAGE_MAX_BYTES = '0';
    process.env.AI_FILE_UPLOAD_MAX_BYTES = '-5';
    vi.resetModules();
    const mod = await import('../uploadLimits');
    expect(mod.MARKDOWN_IMAGE_MAX_BYTES).toBe(15 * 1024 * 1024);
    expect(mod.AI_FILE_UPLOAD_MAX_BYTES).toBe(25 * 1024 * 1024);
  });
});
