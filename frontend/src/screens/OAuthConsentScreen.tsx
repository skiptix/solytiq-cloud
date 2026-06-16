import { useSearchParams } from 'react-router-dom';
import { usePageTitle } from '../hooks/usePageTitle';
import useAuthStore from '../store/useAuthStore';
import { useState } from 'react';
import { apiFetch } from '../api/client';
import Icon from '../components/Icon';

export default function OAuthConsentScreen() {
  usePageTitle('Connect Claude');
  const [searchParams] = useSearchParams();
  const redirectUri = searchParams.get('redirect_uri');
  const state = searchParams.get('state');

  const { fullName, username } = useAuthStore();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  if (!redirectUri || !state) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f9fafb' }}>
        <div style={{ background: '#fff', padding: 40, borderRadius: 16, boxShadow: '0 4px 20px rgba(0,0,0,0.05)', textAlign: 'center', maxWidth: 400 }}>
          <Icon name="error" size={48} color="#ba1a1a" />
          <h2 style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 24, marginTop: 16, marginBottom: 8 }}>Invalid Request</h2>
          <p style={{ fontFamily: 'Inter, sans-serif', color: '#787584', fontSize: 14 }}>The authorization request is missing required parameters.</p>
        </div>
      </div>
    );
  }

  const handleAllow = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiFetch<{ redirectUrl: string }>('/oauth/approve', {
        method: 'POST',
        body: JSON.stringify({ redirect_uri: redirectUri, state })
      });

      if (data.redirectUrl) {
        window.location.href = data.redirectUrl;
      } else {
        throw new Error('No redirect URL returned');
      }
    } catch (err: unknown) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'An error occurred');
      setLoading(false);
    }
  };

  const handleDeny = () => {
    // Just close the window or go back. Claude will handle the timeout/cancellation.
    window.location.href = '/dashboard';
  };

  const displayName = fullName || username;

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg, #fdf8ff 0%, #f5f0ff 100%)', padding: 24 }}>
      <div style={{ width: '100%', maxWidth: 460, background: '#ffffff', border: '1px solid #E5E7EB', borderRadius: 20, padding: '48px 40px', boxShadow: '0 8px 40px rgba(94,77,187,0.08)', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>

        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 24 }}>
          <img src="/solytiq-cloud.png" alt="Solytiq" style={{ width: 64, height: 64, borderRadius: 16, objectFit: 'cover', boxShadow: '0 4px 12px rgba(94,77,187,0.15)' }} />
          <Icon name="sync_alt" size={24} color="#b0acbe" />
          <div style={{ width: 64, height: 64, borderRadius: 16, background: '#F5F3FF', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid #e8e4f0' }}>
            <span style={{ fontSize: 32 }}>🤖</span>
          </div>
        </div>

        <h1 style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 26, fontWeight: 700, color: '#1c1b22', marginBottom: 12, lineHeight: 1.2 }}>
          Connect Claude to Solytiq
        </h1>

        <p style={{ fontFamily: 'Inter, sans-serif', fontSize: 15, color: '#484552', lineHeight: 1.5, marginBottom: 32 }}>
          <strong>Claude</strong> is requesting access to your Solytiq Cloud workspace as <strong>{displayName}</strong>.
        </p>

        <div style={{ width: '100%', background: '#F5F3FF', borderRadius: 12, padding: 20, textAlign: 'left', marginBottom: 32 }}>
          <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 14, fontWeight: 600, color: '#5e4dbb', marginBottom: 16 }}>
            This will allow Claude to:
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <Icon name="check_circle" size={18} color="#5e4dbb" />
              <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#484552', lineHeight: 1.4 }}>Read your tasks, lists, folders, and timelines</span>
            </div>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <Icon name="check_circle" size={18} color="#5e4dbb" />
              <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#484552', lineHeight: 1.4 }}>Create, update, and manage tasks on your behalf</span>
            </div>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <Icon name="check_circle" size={18} color="#5e4dbb" />
              <span style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, color: '#484552', lineHeight: 1.4 }}>Access your workspace files and documents</span>
            </div>
          </div>
        </div>

        {error && (
          <div style={{ width: '100%', padding: '12px 16px', background: '#fff0f0', border: '1px solid #ffd6d6', borderRadius: 8, color: '#ba1a1a', fontFamily: 'Inter, sans-serif', fontSize: 13, marginBottom: 24, textAlign: 'left' }}>
            {error}
          </div>
        )}

        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <button
            onClick={handleAllow}
            disabled={loading}
            style={{ width: '100%', padding: '14px 24px', background: '#5e4dbb', color: '#fff', border: 'none', borderRadius: 10, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 15, fontWeight: 600, cursor: loading ? 'wait' : 'pointer', transition: 'background 0.2s' }}
            onMouseEnter={e => e.currentTarget.style.background = '#4a3b9c'}
            onMouseLeave={e => e.currentTarget.style.background = '#5e4dbb'}
          >
            {loading ? 'Connecting...' : 'Allow Access'}
          </button>

          <button
            onClick={handleDeny}
            disabled={loading}
            style={{ width: '100%', padding: '14px 24px', background: 'transparent', color: '#787584', border: '1px solid #E5E7EB', borderRadius: 10, fontFamily: 'Hanken Grotesk, sans-serif', fontSize: 15, fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer', transition: 'all 0.2s' }}
            onMouseEnter={e => { if(!loading) { e.currentTarget.style.background = '#F9FAFB'; e.currentTarget.style.color = '#1c1b22'; } }}
            onMouseLeave={e => { if(!loading) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#787584'; } }}
          >
            Cancel
          </button>
        </div>

        <div style={{ marginTop: 24, fontFamily: 'Inter, sans-serif', fontSize: 12, color: '#b0acbe' }}>
          You can revoke this access at any time in Settings.
        </div>
      </div>
    </div>
  );
}
