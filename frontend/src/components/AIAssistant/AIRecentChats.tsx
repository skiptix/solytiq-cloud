import type { AISession } from '../../store/useAIStore';
import Icon from '../Icon';
import MotionButton from '../animate-ui/MotionButton';
import MotionIn from '../animate-ui/MotionIn';
import { EASE_SETTLE, EASE_STANDARD } from '../animate-ui/motionTokens';

interface Props {
  sessions: AISession[];
  onSelect: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onClose: () => void;
}

function formatRelativeDate(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function groupByDate(sessions: AISession[]): { label: string; items: AISession[] }[] {
  const groups: Map<string, AISession[]> = new Map();
  for (const s of sessions) {
    const label = formatRelativeDate(s.created_at);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(s);
  }
  return Array.from(groups.entries()).map(([label, items]) => ({ label, items }));
}

export default function AIRecentChats({ sessions, onSelect, onDelete, onClose }: Props) {
  const groups = groupByDate(sessions);

  return (
    <MotionIn
      initial={{ opacity: 0, x: '100%' }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.26, ease: EASE_SETTLE }} style={{
        position: 'absolute',
        inset: 0,
        background: 'var(--color-white)',
        borderRadius: 20,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        zIndex: 15,
      }}
    >
      {/* Header */}
      <div
        style={{
          background: 'linear-gradient(135deg, var(--color-purple-mid-8) 0%, var(--color-purple-mid-13) 100%)',
          padding: '14px 16px 12px',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <MotionButton
          onClick={onClose}
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            background: 'rgba(var(--color-white-rgb), 0.12)',
            border: 'none',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
          whileHover={{ background: 'rgba(var(--color-white-rgb), 0.24)', scale: 1.08 }}
          transition={{ duration: 0.18 }}
        >
          <Icon name="arrow_back" size={15} color="rgba(var(--color-white-rgb), 0.85)" />
        </MotionButton>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontFamily: 'var(--font-heading)',
              fontSize: 15,
              fontWeight: 700,
              color: 'var(--color-white)',
              lineHeight: 1.2,
              letterSpacing: '-0.01em',
            }}
          >
            Recent Chats
          </div>
          <div
            style={{
              fontFamily: 'var(--font-body)',
              fontSize: 11,
              color: 'rgba(var(--color-white-rgb), 0.6)',
              marginTop: 1,
            }}
          >
            Stored for 30 days
          </div>
        </div>
      </div>

      {/* Sessions list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '6px 8px 8px' }}>
        {sessions.length === 0 ? (
          <MotionIn
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, ease: EASE_STANDARD }} style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              gap: 10,
              padding: 24,
            }}
          >
            <div
              style={{
                width: 52,
                height: 52,
                borderRadius: '50%',
                background: 'linear-gradient(135deg, var(--color-surface-tint-4) 0%, var(--color-surface-tint) 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 4px 16px rgba(var(--color-purple-mid-8-rgb), 0.12)',
              }}
            >
              <Icon name="chat_bubble_outline" size={22} color="var(--color-accent-purple-light)" />
            </div>
            <div
              style={{
                fontFamily: 'var(--font-body)',
                fontSize: 13,
                color: 'var(--color-text-tertiary)',
                textAlign: 'center',
                lineHeight: 1.5,
              }}
            >
              No previous chats yet.<br />Start a conversation with Sol!
            </div>
          </MotionIn>
        ) : (
          groups.map(({ label, items }, groupIdx) => (
            <div key={label}>
              <MotionIn
                initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28, delay: (groupIdx * 40) / 1000, ease: EASE_STANDARD }} style={{
                  fontFamily: 'var(--font-body)',
                  fontSize: 10.5,
                  fontWeight: 600,
                  color: 'var(--color-text-quaternary)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.07em',
                  padding: '10px 8px 4px',
                }}
              >
                {label}
              </MotionIn>
              {items.map((session, itemIdx) => {
                const delay = groupIdx * 40 + itemIdx * 35 + 40;
                return (
                  // The row is the variant parent: its own hover state both
                  // shifts/tints the row AND reveals the delete button below,
                  // which used to be faked with a `ref` callback forcing a
                  // permanent 0.4 opacity because plain inline styles have no
                  // way to express "on ancestor hover".
                  <MotionIn
                    key={session.id}
                    initial="hidden"
                    animate="visible"
                    whileHover="hover"
                    variants={{
                      hidden: { opacity: 0, y: 8 },
                      visible: {
                        opacity: 1, y: 0, x: 0, background: 'transparent',
                        transition: { duration: 0.28, delay: delay / 1000, ease: EASE_STANDARD },
                      },
                      hover: {
                        x: 2, background: 'var(--color-surface-tint)',
                        transition: { duration: 0.18, ease: EASE_STANDARD },
                      },
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      borderRadius: 12,
                      padding: '9px 10px',
                      cursor: 'pointer',
                    }}
                    onClick={() => onSelect(session.id)}
                  >
                    <div
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: 10,
                        background: 'linear-gradient(135deg, var(--color-surface-tint-4) 0%, var(--color-purple-pale-33) 100%)',
                        flexShrink: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Icon name="chat" size={15} color="var(--color-purple-mid-2)" />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontFamily: 'var(--font-body)',
                          fontSize: 13,
                          color: 'var(--color-text-primary)',
                          fontWeight: 500,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          lineHeight: 1.3,
                        }}
                      >
                        {session.title ?? 'New conversation'}
                      </div>
                      <div
                        style={{
                          fontFamily: 'var(--font-body)',
                          fontSize: 11,
                          color: 'var(--color-text-quaternary)',
                          marginTop: 2,
                        }}
                      >
                        {new Date(session.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </div>
                    {/* Reveal is inherited from the row's variant label; the
                        button keeps its OWN object `whileHover` for the
                        press-target feedback. Separating the two onto two
                        elements avoids relying on how a child's own gesture
                        prop interacts with an inherited variant label. */}
                    <MotionIn
                      variants={{
                        hidden: { opacity: 0 },
                        visible: { opacity: 0 },
                        hover: { opacity: 1 },
                      }}
                      transition={{ duration: 0.18, ease: EASE_STANDARD }}
                      style={{ display: 'flex', flexShrink: 0 }}
                    >
                      <MotionButton
                        onClick={(e) => { e.stopPropagation(); onDelete(session.id); }}
                        title="Delete chat"
                        style={{
                          width: 28,
                          height: 28,
                          borderRadius: 7,
                          background: 'transparent',
                          border: 'none',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                        }}
                        whileHover={{ background: 'var(--color-red-pale-4)', scale: 1.1 }}
                        transition={{ duration: 0.18 }}
                      >
                        <Icon name="delete" size={14} color="var(--color-error)" />
                      </MotionButton>
                    </MotionIn>
                  </MotionIn>
                );
              })}
            </div>
          ))
        )}
      </div>
    </MotionIn>
  );
}
