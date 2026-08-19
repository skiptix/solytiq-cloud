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
//
// The logo is a REMOTE <img> (frontend's own public /icons/icon-192.png —
// the same flattened, opaque PWA icon; see CLAUDE.md's "Home Screen Install"
// section), not a base64 data URI. Gmail, Yahoo, and Outlook.com all strip
// `data:` image sources from mail entirely for spam/security reasons — a
// data URI here silently renders as a broken-image icon next to its alt
// text, which is worse than no logo at all. A same-origin HTTPS URL is the
// one embedding method every mainstream mail client actually supports.
// ---------------------------------------------------------------------------

export interface EmailContent {
  subject: string;
  html: string;
}

// Same two-family split as the app itself (index.css's --font-heading /
// --font-body) — Hanken Grotesk for headings/labels/buttons, Inter for body
// copy. Both degrade to the system font stack when a client won't load the
// Google Fonts <link> below (most notably Gmail, which never loads web
// fonts in mail at all) — the fallback is deliberately the same platform
// sans-serif stack either family would otherwise render in.
const SYSTEM_FALLBACK = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const HEADING_FONT_STACK = `'Hanken Grotesk', ${SYSTEM_FALLBACK}`;
const BODY_FONT_STACK = `'Inter', ${SYSTEM_FALLBACK}`;

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
 *  when neither env var is configured, and callers omit the CTA button/logo. */
export function getAppBaseUrlForEmail(): string | null {
  const configured = process.env.PUBLIC_URL || process.env.FRONTEND_URL;
  return configured ? configured.replace(/\/+$/, '') : null;
}

/**
 * Renders one branded notification email. `ctaPath` is a relative in-app
 * route (e.g. `/dashboard`, `/list/abc123`); it, and the logo image, only
 * appear when an app base URL is configured — see getAppBaseUrlForEmail().
 * With no base URL configured, the header falls back to a text-only
 * wordmark so the email still reads as branded rather than blank.
 */
export function buildNotificationEmail(opts: {
  heading: string;
  bodyText: string;
  ctaLabel?: string;
  ctaPath?: string;
}): EmailContent {
  const baseUrl = getAppBaseUrlForEmail();
  const ctaUrl = baseUrl ? `${baseUrl}${opts.ctaPath ?? '/dashboard'}` : null;
  const logoUrl = baseUrl ? `${baseUrl}/icons/icon-192.png` : null;
  const heading = escapeHtml(opts.heading);
  const bodyHtml = escapeHtml(opts.bodyText).replace(/\n/g, '<br>');
  // The inbox preview line (Gmail/Apple Mail/Outlook all show this before the
  // subject or right after it) — without one, clients fall back to showing
  // raw markup fragments from the top of <body>, which looks broken/cheap.
  const preheader = escapeHtml(opts.bodyText.slice(0, 140));

  const logo = logoUrl
    ? `<img src="${logoUrl}" width="56" height="56" alt="Solytiq Cloud" style="display: block; width: 56px; height: 56px; border-radius: 14px; box-shadow: 0 8px 20px rgba(94, 77, 187, 0.28);" />`
    : '';

  const button = ctaUrl
    ? `
                  <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 4px auto 0;">
                    <tr>
                      <td style="border-radius: 10px; background-color: #5e4dbb;">
                        <a href="${ctaUrl}" style="display: inline-block; padding: 12px 28px; font-family: ${HEADING_FONT_STACK}; font-size: 14px; font-weight: 600; color: #ffffff; text-decoration: none; text-align: center; border-radius: 10px;">
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
    <!--[if !mso]><!-->
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
    <!--<![endif]-->
  </head>
  <body style="margin: 0; padding: 0; background-color: #EEEAFB; font-family: ${BODY_FONT_STACK};">
    <div style="display: none; max-height: 0; overflow: hidden; opacity: 0; mso-hide: all;">
      ${preheader}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;
    </div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #EEEAFB;">
      <tr>
        <td align="center" style="padding: 40px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 480px;">

            <!-- Logo header -->
            <tr>
              <td align="center" style="padding: 0 0 20px;">
                ${logo}
                <div style="margin-top: 12px; font-family: ${HEADING_FONT_STACK}; font-size: 15px; font-weight: 700; color: #5e4dbb;">Solytiq Cloud</div>
              </td>
            </tr>

            <!-- Card -->
            <tr>
              <td align="center" style="background-color: #ffffff; border: 1px solid #e8e4f0; border-radius: 18px; box-shadow: 0 8px 40px rgba(94, 77, 187, 0.12); padding: 36px 32px;">
                <div style="font-family: ${HEADING_FONT_STACK}; font-size: 19px; font-weight: 700; color: #1c1b22; line-height: 1.4; text-align: center;">${heading}</div>
                <div style="margin-top: 10px; font-family: ${BODY_FONT_STACK}; font-size: 14.5px; color: #4b4758; line-height: 1.65; text-align: center;">${bodyHtml}</div>
                ${button}
              </td>
            </tr>

            <!-- Footer, outside the card -->
            <tr>
              <td align="center" style="padding: 24px 24px 0;">
                <div style="font-family: ${BODY_FONT_STACK}; font-size: 12px; color: #8983a8; line-height: 1.6; text-align: center;">
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
