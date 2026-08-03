import { useNavigate } from 'react-router-dom';
import type { AutomationOwnerEntityType } from '../types';
import useInstalledAppsStore from '../store/useInstalledAppsStore';
import Icon from './Icon';

interface AutomationsButtonProps {
  ownerType: AutomationOwnerEntityType;
  ownerId: string;
  isMobile?: boolean;
}

/** The single entry point into a Board/Page/Timeline's automations —
 *  replaces the old workspace-wide sidebar nav item now that automations are
 *  attached to one item at a time (see backend/src/routes/automations.ts).
 *  Hidden entirely unless the Automation Hub app is installed, same gate the
 *  sidebar item used to check. */
export default function AutomationsButton({ ownerType, ownerId, isMobile }: AutomationsButtonProps) {
  const navigate = useNavigate();
  const installed = useInstalledAppsStore((s) => s.isInstalled('automations'));
  if (!installed) return null;

  return (
    <button
      onClick={() => navigate(`/automations?ownerType=${ownerType}&ownerId=${ownerId}`)}
      title="Automations"
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, height: 32, width: isMobile ? 32 : undefined, padding: isMobile ? 0 : '0 11px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-white)', cursor: 'pointer', transition: 'all 120ms', flexShrink: 0 }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-orange-pale-5)'; e.currentTarget.style.borderColor = 'var(--color-warning-alt)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--color-white)'; e.currentTarget.style.borderColor = 'var(--color-border)'; }}>
      <Icon name="bolt" size={15} color="var(--color-warning-alt)" />
      {!isMobile && <span style={{ fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, color: 'var(--color-warning-alt)' }}>Automations</span>}
    </button>
  );
}
