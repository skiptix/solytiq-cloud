import { usePageTitle } from "../hooks/usePageTitle";
import { Link } from 'react-router-dom';
import Icon from '../components/Icon';
import MotionIn from '../components/animate-ui/MotionIn';
import { motion } from '../components/animate-ui/motion';

const MotionLink = motion.create(Link);

interface NotFoundScreenProps {
  /** true (default): render as a full standalone page (gradient background +
   *  logo), for public/unauthenticated routes like an expired invite link.
   *  false: render just the content card, sized to fill whatever container
   *  it's embedded in (used inside AppLayout's own chrome for a bad in-app
   *  route, where the Sidebar/TopBar already provide the page frame). */
  standalone?: boolean;
}

/**
 * The one, real 404 — used both for genuinely unmatched routes and for any
 * link whose target is gone/invalid in a way that must not be distinguished
 * from "never existed" (e.g. an already-used invitation link — see
 * AcceptInviteScreen.tsx and backend/src/userInvitations.ts's header
 * comment for why that's a security requirement, not a UX shortcut).
 */
export default function NotFoundScreen({ standalone = true }: NotFoundScreenProps) {
  usePageTitle('Page Not Found');

  const card = (
    <MotionIn
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32 }}
      style={{
        width: '100%', maxWidth: 420, background: 'var(--color-white)',
        border: '1px solid var(--color-border-alt)', borderRadius: 20,
        padding: '48px 40px', textAlign: 'center',
        boxShadow: '0 1px 2px rgba(var(--color-black-rgb), 0.05)',
      }}
    >
      <div style={{ width: 64, height: 64, borderRadius: 18, background: 'var(--color-surface-tint)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
        <Icon name="search_off" size={30} color="var(--color-primary)" />
      </div>
      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 700, color: 'var(--color-primary)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>404</div>
      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 24, fontWeight: 700, color: 'var(--color-text-primary)', marginTop: 8, letterSpacing: '-0.01em' }}>Page not found</div>
      <div style={{ fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--color-text-secondary)', lineHeight: 1.6, marginTop: 10 }}>
        This page doesn't exist, or you no longer have access to it.
      </div>
      <MotionLink
        to="/"
        whileHover={{ background: 'var(--color-purple-mid-11)' }}
        transition={{ duration: 0.15 }}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 24, background: 'var(--color-primary)', color: 'var(--color-white)', fontFamily: 'var(--font-heading)', fontSize: 14, fontWeight: 600, padding: '11px 22px', borderRadius: 10, textDecoration: 'none' }}
      >
        <Icon name="home" size={16} color="var(--color-white)" />
        Go home
      </MotionLink>
    </MotionIn>
  );

  if (!standalone) {
    return (
      <div style={{ minHeight: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        {card}
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(135deg, var(--color-page-bg) 0%, var(--color-purple-pale-12) 100%)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 24, padding: 24 }}>
      <img src="/solytiq-cloud.png" alt="Solytiq Cloud" style={{ width: 64, height: 64, borderRadius: 16, objectFit: 'cover', boxShadow: '0 4px 20px rgba(var(--color-primary-rgb), 0.18)' }} />
      {card}
    </div>
  );
}
