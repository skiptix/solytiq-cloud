import { useSearchParams } from 'react-router-dom';
import { usePageTitle } from '../hooks/usePageTitle';
import useAuthStore from '../store/useAuthStore';
import { useEffect, useState } from 'react';
import { apiOAuthApprove, apiOAuthClientInfo, type OAuthClientInfo } from '../api/client';
import Icon from '../components/Icon';

// SECURITY (S3): this screen used to hardcode "Claude" as the requesting
// client's name, unconditionally, regardless of which client_id was in the
// URL — since Dynamic Client Registration (POST /api/oauth/register) is
// open to anyone (by design, per RFC 7591), that meant ANY attacker could
// register their own OAuth client, send a victim a consent link, and have
// this screen tell the victim they were approving "Claude" while the
// authorization code (and the full-power PAT it's exchanged for) actually
// went to the attacker's own redirect_uri. The fix: fetch the REGISTERED
// client_name and the server-computed `trusted` verdict from
// GET /oauth/client-info (backend/src/routes/oauth.ts) — trusted is true
// only when the redirect_uri's host is on the operator's own allowlist,
// which a self-registered client cannot forge — and render a visibly
// different, unmistakably "third-party, unverified" card whenever it's false,
// always showing the actual redirect host so a user has a real signal to
// check against, rather than a claimed name alone.
export default function OAuthConsentScreen() {
  const [searchParams] = useSearchParams();
  const clientId = searchParams.get('client_id');
  const redirectUri = searchParams.get('redirect_uri');
  const codeChallenge = searchParams.get('code_challenge');
  const codeChallengeMethod = searchParams.get('code_challenge_method');
  const state = searchParams.get('state') ?? undefined;
  const scope = searchParams.get('scope') ?? undefined;
  const resource = searchParams.get('resource') ?? undefined;

  const { fullName, username } = useAuthStore();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [clientInfo, setClientInfo] = useState<OAuthClientInfo | null>(null);
  const [clientInfoError, setClientInfoError] = useState('');

  const missingParams = !clientId || !redirectUri || !codeChallenge || codeChallengeMethod !== 'S256';

  usePageTitle(clientInfo?.trusted ? 'Connect Claude' : 'Authorize app');

  useEffect(() => {
    if (missingParams) return;
    apiOAuthClientInfo(clientId!, redirectUri!)
      .then(setClientInfo)
      .catch((err: unknown) => setClientInfoError(err instanceof Error ? err.message : 'Could not verify this request'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missingParams]);

  if (missingParams) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-surface-gray)' }}>
        <div style={{ background: 'var(--color-white)', padding: 40, borderRadius: 16, boxShadow: '0 4px 20px rgba(var(--color-black-rgb), 0.05)', textAlign: 'center', maxWidth: 400 }}>
          <Icon name="error" size={48} color="var(--color-error)" />
          <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: 24, marginTop: 16, marginBottom: 8 }}>Invalid Request</h2>
          <p style={{ fontFamily: 'var(--font-body)', color: 'var(--color-text-tertiary)', fontSize: 14 }}>The authorization request is missing required parameters or uses an unsupported method.</p>
        </div>
      </div>
    );
  }

  if (clientInfoError) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-surface-gray)' }}>
        <div style={{ background: 'var(--color-white)', padding: 40, borderRadius: 16, boxShadow: '0 4px 20px rgba(var(--color-black-rgb), 0.05)', textAlign: 'center', maxWidth: 400 }}>
          <Icon name="error" size={48} color="var(--color-error)" />
          <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: 24, marginTop: 16, marginBottom: 8 }}>Couldn't verify this request</h2>
          <p style={{ fontFamily: 'var(--font-body)', color: 'var(--color-text-tertiary)', fontSize: 14 }}>{clientInfoError}</p>
        </div>
      </div>
    );
  }

  const handleAllow = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiOAuthApprove({
        client_id: clientId!,
        redirect_uri: redirectUri!,
        code_challenge: codeChallenge!,
        code_challenge_method: codeChallengeMethod!,
        state,
        scope,
        resource,
      });
      if (data.redirectUrl) {
        window.location.href = data.redirectUrl;
      } else {
        throw new Error('No redirect URL returned');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'An error occurred');
      setLoading(false);
    }
  };

  const handleDeny = () => {
    window.location.href = '/dashboard';
  };

  const displayName = fullName || username;
  const trusted = clientInfo?.trusted ?? false;
  const shownName = trusted ? 'Claude' : (clientInfo?.clientName ?? '…');

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg, var(--color-page-bg) 0%, var(--color-purple-pale-12) 100%)', padding: 24 }}>
      <div style={{ width: '100%', maxWidth: 460, background: 'var(--color-white)', border: `1px solid ${trusted ? 'var(--color-border-alt)' : 'var(--color-warning)'}`, borderRadius: 20, padding: '48px 40px', boxShadow: '0 8px 40px rgba(var(--color-primary-rgb), 0.08)', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>

        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 24 }}>
          <img src="/solytiq-cloud.png" alt="Solytiq" style={{ width: 64, height: 64, borderRadius: 16, objectFit: 'cover', boxShadow: '0 4px 12px rgba(var(--color-primary-rgb), 0.15)' }} />
          <Icon name="sync_alt" size={24} color="var(--color-text-quaternary)" />
          <div style={{ width: 64, height: 64, borderRadius: 16, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--color-border)' }}>
            <span style={{ fontSize: 32 }}>{trusted ? '🤖' : '❓'}</span>
          </div>
        </div>

        {!trusted && (
          <div style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, background: 'var(--color-warning-bg, #fff7ed)', border: '1px solid var(--color-warning)', borderRadius: 10, padding: '10px 14px', marginBottom: 20, textAlign: 'left' }}>
            <Icon name="warning" size={18} color="var(--color-warning)" />
            <span style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-secondary)', lineHeight: 1.4 }}>
              This is a <strong>third-party app</strong>, not verified as Claude. Only continue if you registered this connector yourself.
            </span>
          </div>
        )}

        <h1 style={{ fontFamily: 'var(--font-heading)', fontSize: 26, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 12, lineHeight: 1.2 }}>
          {trusted ? 'Connect Claude to Solytiq' : `Authorize "${shownName}"`}
        </h1>

        <p style={{ fontFamily: 'var(--font-body)', fontSize: 15, color: 'var(--color-text-secondary)', lineHeight: 1.5, marginBottom: 12 }}>
          <strong>{shownName}</strong> is requesting access to your Solytiq Cloud workspace as <strong>{displayName}</strong>.
        </p>

        {clientInfo?.redirectHost && (
          <p style={{ fontFamily: 'var(--font-body)', fontSize: 12.5, color: 'var(--color-text-quaternary)', marginBottom: 24 }}>
            Access will be granted to: <code style={{ fontFamily: 'var(--font-mono, monospace)', color: 'var(--color-text-tertiary)' }}>{clientInfo.redirectHost}</code>
          </p>
        )}

        <div style={{ width: '100%', background: 'var(--color-surface-tint)', borderRadius: 12, padding: 20, textAlign: 'left', marginBottom: 32 }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, color: 'var(--color-primary)', marginBottom: 16 }}>
            {shownName} will be able to do anything you can do in Solytiq:
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <Icon name="check_circle" size={18} color="var(--color-primary)" />
              <span style={{ fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--color-text-secondary)', lineHeight: 1.4 }}>Read your tasks, lists, folders, and timelines</span>
            </div>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <Icon name="check_circle" size={18} color="var(--color-primary)" />
              <span style={{ fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--color-text-secondary)', lineHeight: 1.4 }}>Create, update, and delete tasks on your behalf</span>
            </div>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <Icon name="check_circle" size={18} color="var(--color-primary)" />
              <span style={{ fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--color-text-secondary)', lineHeight: 1.4 }}>Access your workspace files and documents</span>
            </div>
          </div>
        </div>

        {error && (
          <div style={{ width: '100%', padding: '12px 16px', background: 'var(--color-red-pale-4)', border: '1px solid var(--color-red-pale-9)', borderRadius: 8, color: 'var(--color-error)', fontFamily: 'var(--font-body)', fontSize: 13, marginBottom: 24, textAlign: 'left' }}>
            {error}
          </div>
        )}

        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <button
            onClick={handleAllow}
            disabled={loading || !clientInfo}
            style={{ width: '100%', padding: '14px 24px', background: 'var(--color-primary)', color: 'var(--color-white)', border: 'none', borderRadius: 10, fontFamily: 'var(--font-heading)', fontSize: 15, fontWeight: 600, cursor: loading || !clientInfo ? 'wait' : 'pointer', transition: 'background 0.2s' }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--color-purple-mid-14)'}
            onMouseLeave={e => e.currentTarget.style.background = 'var(--color-primary)'}
          >
            {loading ? 'Connecting...' : 'Allow Access'}
          </button>

          <button
            onClick={handleDeny}
            disabled={loading}
            style={{ width: '100%', padding: '14px 24px', background: 'transparent', color: 'var(--color-text-tertiary)', border: '1px solid var(--color-border-alt)', borderRadius: 10, fontFamily: 'var(--font-heading)', fontSize: 15, fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer', transition: 'all 0.2s' }}
            onMouseEnter={e => { if(!loading) { e.currentTarget.style.background = 'var(--color-surface-gray)'; e.currentTarget.style.color = 'var(--color-text-primary)'; } }}
            onMouseLeave={e => { if(!loading) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--color-text-tertiary)'; } }}
          >
            Cancel
          </button>
        </div>

        <div style={{ marginTop: 24, fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--color-text-quaternary)' }}>
          You can disconnect {shownName} at any time in Settings.
        </div>
      </div>
    </div>
  );
}
