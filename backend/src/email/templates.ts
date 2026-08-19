// ---------------------------------------------------------------------------
// Email templates — one shared HTML wrapper (Luminous List palette, inline
// styles only, since email clients strip <style> blocks and CSS variables)
// around a per-notification heading/body/CTA. Deliberately NOT part of the
// Animate-UI layer's "no raw HTML/CSS outside components" convention — that
// rule governs the app's own React tree; this is server-rendered markup for a
// third-party mail client and has nothing to animate.
// ---------------------------------------------------------------------------

export interface EmailContent {
  subject: string;
  html: string;
}

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
 * an app base URL is configured — see getAppBaseUrlForEmail().
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

  const button = ctaUrl
    ? `
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 28px 0 4px;">
        <tr>
          <td style="border-radius: 10px; background: #5e4dbb;">
            <a href="${ctaUrl}" style="display: inline-block; padding: 11px 22px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; font-weight: 600; color: #ffffff; text-decoration: none; border-radius: 10px;">
              ${escapeHtml(opts.ctaLabel ?? 'Open Solytiq Cloud')}
            </a>
          </td>
        </tr>
      </table>`
    : '';

  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${heading}</title>
  </head>
  <body style="margin: 0; padding: 0; background: #F5F3FF; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background: #F5F3FF; padding: 32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 480px; background: #ffffff; border-radius: 18px; border: 1px solid #e8e4f0; overflow: hidden;">
            <tr>
              <td style="height: 4px; background: linear-gradient(90deg, #5e4dbb, #8a7ae0);"></td>
            </tr>
            <tr>
              <td style="padding: 28px 28px 8px;">
                <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 13px; font-weight: 700; color: #5e4dbb; letter-spacing: 0.04em; text-transform: uppercase;">Solytiq Cloud</div>
              </td>
            </tr>
            <tr>
              <td style="padding: 8px 28px 4px;">
                <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 19px; font-weight: 700; color: #1c1b22; line-height: 1.35;">${heading}</div>
              </td>
            </tr>
            <tr>
              <td style="padding: 6px 28px 4px;">
                <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; color: #484552; line-height: 1.6;">${bodyHtml}</div>
              </td>
            </tr>
            <tr>
              <td style="padding: 0 28px 28px;">
                ${button}
              </td>
            </tr>
            <tr>
              <td style="padding: 16px 28px; border-top: 1px solid #f0ecf8;">
                <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 11.5px; color: #b0acbe;">
                  You're receiving this because of your notification preferences in Solytiq Cloud. You can change them anytime in Account Settings → Notifications.
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
