import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret, isEncryptedSecret } from '../resendCrypto';
import { buildNotificationEmail, getAppBaseUrlForEmail } from '../email/templates';
import { shouldEmailNotification, DEFAULT_EMAIL_PREFS } from '../notifications';

describe('resendCrypto', () => {
  it('round-trips a secret through encrypt/decrypt', () => {
    const plain = 're_1234567890_abcdefghijklmnopqrstuvwx';
    const enc = encryptSecret(plain);
    expect(isEncryptedSecret(enc)).toBe(true);
    expect(enc).not.toContain(plain);
    expect(decryptSecret(enc)).toBe(plain);
  });

  it('produces different ciphertext for the same plaintext each time (fresh IV)', () => {
    const plain = 're_same_key';
    expect(encryptSecret(plain)).not.toBe(encryptSecret(plain));
  });

  it('passes through a still-plaintext / foreign value unchanged', () => {
    expect(decryptSecret('re_never_encrypted')).toBe('re_never_encrypted');
    expect(isEncryptedSecret('re_never_encrypted')).toBe(false);
  });
});

describe('shouldEmailNotification', () => {
  it('only emails automation_run when the run failed', () => {
    expect(shouldEmailNotification('automation_run', { status: 'failed' })).toBe(true);
    expect(shouldEmailNotification('automation_run', { status: 'success' })).toBe(false);
    expect(shouldEmailNotification('automation_run', undefined)).toBe(false);
  });

  it('emails every other type unconditionally', () => {
    for (const type of ['mention', 'workspace_added', 'meeting_reminder', 'item_tagged'] as const) {
      expect(shouldEmailNotification(type, undefined)).toBe(true);
    }
  });
});

describe('DEFAULT_EMAIL_PREFS', () => {
  it('defaults the four explicitly-requested types to on', () => {
    expect(DEFAULT_EMAIL_PREFS.mention).toBe(true);
    expect(DEFAULT_EMAIL_PREFS.workspace_added).toBe(true);
    expect(DEFAULT_EMAIL_PREFS.automation_run).toBe(true);
    expect(DEFAULT_EMAIL_PREFS.meeting_reminder).toBe(true);
  });

  it('defaults low-urgency agent/deadline types to off', () => {
    expect(DEFAULT_EMAIL_PREFS.deadline_overdue).toBe(false);
    expect(DEFAULT_EMAIL_PREFS.agent_run_complete).toBe(false);
    expect(DEFAULT_EMAIL_PREFS.agent_proposal).toBe(false);
    expect(DEFAULT_EMAIL_PREFS.agent_change).toBe(false);
  });
});

describe('buildNotificationEmail', () => {
  it('escapes HTML in heading/body so a title can never inject markup', () => {
    const { html, subject } = buildNotificationEmail({
      heading: '<script>alert(1)</script>',
      bodyText: 'hello & "world"',
    });
    expect(subject).toBe('<script>alert(1)</script>');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
  });

  it('omits the CTA button when no app base URL is configured', () => {
    const prevPublic = process.env.PUBLIC_URL;
    const prevFrontend = process.env.FRONTEND_URL;
    delete process.env.PUBLIC_URL;
    delete process.env.FRONTEND_URL;
    try {
      expect(getAppBaseUrlForEmail()).toBeNull();
      const { html } = buildNotificationEmail({ heading: 'Hi', bodyText: 'Body' });
      expect(html).not.toContain('<a href=');
    } finally {
      if (prevPublic !== undefined) process.env.PUBLIC_URL = prevPublic;
      if (prevFrontend !== undefined) process.env.FRONTEND_URL = prevFrontend;
    }
  });

  it('builds an absolute CTA link when an app base URL is configured', () => {
    const prev = process.env.PUBLIC_URL;
    process.env.PUBLIC_URL = 'https://solytiq.example';
    try {
      const { html } = buildNotificationEmail({ heading: 'Hi', bodyText: 'Body', ctaPath: '/list/abc' });
      expect(html).toContain('href="https://solytiq.example/list/abc"');
    } finally {
      if (prev !== undefined) process.env.PUBLIC_URL = prev; else delete process.env.PUBLIC_URL;
    }
  });
});
