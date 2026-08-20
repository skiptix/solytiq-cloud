import Icon from './Icon';
import MotionButton from './animate-ui/MotionButton';

interface HideEmptySectionsButtonProps {
  active: boolean;
  onToggle: () => void;
  isMobile?: boolean;
}

/**
 * Toggles whether sections with no tasks are hidden from this board's
 * List/Kanban/Timeline views — sits beside the Automations entry point since
 * both are per-board display controls scoped to a single item. Persisted
 * (`lists.quickAddHideEmptySections`) the same way the view-mode switcher is,
 * so the choice is the same on every device rather than a local UI toggle.
 * Only rendered for boards with Quick Add on — see ListScreen.tsx.
 */
export default function HideEmptySectionsButton({ active, onToggle, isMobile }: HideEmptySectionsButtonProps) {
  return (
    <MotionButton
      onClick={onToggle}
      title={active ? 'Empty sections are hidden — click to show them' : 'Showing all sections, including empty ones'}
      animate={{
        background: active ? 'var(--color-surface-tint)' : 'var(--color-white)',
        borderColor: active ? 'var(--color-primary)' : 'var(--color-border)',
      }}
      transition={{ duration: 0.12 }}
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, height: 32, width: isMobile ? 32 : undefined, padding: isMobile ? 0 : '0 11px', borderRadius: 8, borderWidth: 1, borderStyle: 'solid', cursor: 'pointer', flexShrink: 0 }}>
      <Icon name={active ? 'visibility_off' : 'visibility'} size={15} color={active ? 'var(--color-primary)' : 'var(--color-text-tertiary)'} />
      {!isMobile && (
        <span style={{ fontFamily: 'var(--font-heading)', fontSize: 12.5, fontWeight: 600, color: active ? 'var(--color-primary)' : 'var(--color-text-tertiary)' }}>
          {active ? 'Empty hidden' : 'Show empty'}
        </span>
      )}
    </MotionButton>
  );
}
