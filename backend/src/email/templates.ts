// ---------------------------------------------------------------------------
// Email templates — one shared HTML wrapper (Luminous List palette, inline
// styles only, since email clients strip <style> blocks and CSS variables)
// around a per-notification heading/body/CTA. Deliberately NOT part of the
// Animate-UI layer's "no raw HTML/CSS outside components" convention — that
// rule governs the app's own React tree; this is server-rendered markup for a
// third-party mail client and has nothing to animate.
//
// Layout is table-based (not flex/grid) because that's still the only markup
// Outlook's Word rendering engine reliably lays out — the same constraint
// every transactional-email template in the wild works around.
// ---------------------------------------------------------------------------

import { LOGO_DATA_URI } from './logo';

export interface EmailContent {
  subject: string;
  html: string;
}

const FONT_STACK = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The app's public origin, for building absolute links inside an email
 *  (relative URLs make no sense outside a browser tab). Unlike publicUrl.ts's
 *  getPublicBaseUrl(), this has no Request to fall back on — sweeps and
 *  notification writers run outside any HTTP request — so it returns null
 *  when neither env var is configured, and callers omit the CTA button. */
export function getAppBaseUrlForEmail(): string | null {
  const configured = process.env.PUBLIC_URL || process.env.FRONTEND_URL;
  return configured ? configured.replace(/\/+$/, '') : null;
}

/**
 * Renders one branded notification email. `ctaPath` is a relative in-app
 * route (e.g. `/dashboard`, `/list/abc123`); it only becomes a button when
 * an app base URL is configured — see getAppBaseUrlForEmail(). The logo mark
 * is always embedded (inline base64 — see logo.ts), so the brand header
 * renders identically whether or not PUBLIC_URL/FRONTEND_URL is set.
 */
export function buildNotificationEmail(opts: {
  heading: string;
  bodyText: string;
  ctaLabel?: string;
  ctaPath?: string;
}): EmailContent {
  const baseUrl = getAppBaseUrlForEmail();
  const ctaUrl = baseUrl ? `${baseUrl}${opts.ctaPath ?? '/dashboard'}` : null;
  const heading = escapeHtml(opts.heading);
  const bodyHtml = escapeHtml(opts.bodyText).replace(/\n/g, '<br>');
  // The inbox preview line (Gmail/Apple Mail/Outlook all show this before the
  // subject or right after it) — without one, clients fall back to showing
  // raw markup fragments from the top of <body>, which looks broken/cheap.
  const preheader = escapeHtml(opts.bodyText.slice(0, 140));

  const button = ctaUrl
    ? `
                  <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 8px 0 0;">
                    <tr>
                      <td style="border-radius: 10px; background-color: #5e4dbb;">
                        <a href="${ctaUrl}" style="display: inline-block; padding: 12px 26px; font-family: ${FONT_STACK}; font-size: 14px; font-weight: 600; color: #ffffff; text-decoration: none; border-radius: 10px;">
                          ${escapeHtml(opts.ctaLabel ?? 'Open Solytiq Cloud')}
                        </a>
                      </td>
                    </tr>
                  </table>`
    : '';

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <meta name="supported-color-schemes" content="light" />
    <title>${heading}</title>
  </head>
  <body style="margin: 0; padding: 0; background-color: #EEEAFB; font-family: ${FONT_STACK};">
    <div style="display: none; max-height: 0; overflow: hidden; opacity: 0; mso-hide: all;">
      ${preheader}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;
    </div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #EEEAFB;">
      <tr>
        <td align="center" style="padding: 40px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 520px;">

            <!-- Logo header -->
            <tr>
              <td align="center" style="padding: 0 0 24px;">
                <img src="${LOGO_DATA_URI}" width="60" height="60" alt="Solytiq Cloud" style="display: block; width: 60px; height: 60px; border-radius: 16px; box-shadow: 0 10px 24px rgba(94, 77, 187, 0.28);" />
                <div style="margin-top: 14px; font-family: ${FONT_STACK}; font-size: 12px; font-weight: 700; color: #6f5fd1; letter-spacing: 0.12em; text-transform: uppercase;">Solytiq Cloud</div>
              </td>
            </tr>

            <!-- Card -->
            <tr>
              <td style="background-color: #ffffff; border: 1px solid #E9E5F7; border-radius: 20px; box-shadow: 0 20px 48px rgba(45, 33, 105, 0.10);">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="height: 3px; background: linear-gradient(90deg, #5e4dbb 0%, #8a7ae0 100%); border-radius: 20px 20px 0 0;"></td>
                  </tr>
                  <tr>
                    <td style="padding: 32px 36px 4px;">
                      <div style="font-family: ${FONT_STACK}; font-size: 20px; font-weight: 700; color: #1c1b22; line-height: 1.35;">${heading}</div>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding: 10px 36px 4px;">
                      <div style="font-family: ${FONT_STACK}; font-size: 14.5px; color: #4b4758; line-height: 1.65;">${bodyHtml}</div>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 36px 32px;">
                      ${button}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Footer, outside the card -->
            <tr>
              <td align="center" style="padding: 28px 24px 0;">
                <div style="font-family: ${FONT_STACK}; font-size: 12px; color: #8983a8; line-height: 1.6;">
                  You're receiving this because of your notification preferences in Solytiq Cloud.<br />
                  You can change them anytime in Account Settings → Notifications.
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject: opts.heading, html };
}
