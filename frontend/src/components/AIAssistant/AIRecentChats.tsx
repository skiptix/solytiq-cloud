import type { AISession } from '../../store/useAIStore';
import Icon from '../Icon';

interface Props {
  sessions: AISession[];
  onSelect: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onClose: () => void;
}

function formatSessionDate(isoString: string): string {
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
    const label = formatSessionDate(s.created_at);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(s);
  }
  return Array.from(groups.entries()).map(([label, items]) => ({ label, items }));
}

export default function AIRecentChats({ sessions, onSelect, onDelete, onClose }: Props) {
  const groups = groupByDate(sessions);

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: '#fff',
        borderRadius: 20,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        zIndex: 5,
      }}
    >
      {/* Header */}
      <div
        style={{
          background: 'linear-gradient(135deg, #6b5bcc 0%, #4a39aa 100%)',
          padding: '14px 16px 12px',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <button
          onClick={onClose}
          style={{
            width: 28,
            height: 28,
            borderRadius: 7,
            background: 'rgba(255,255,255,0.12)',
            border: 'none',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.22)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.12)'; }}
        >
          <Icon name="arrow_back" size={15} color="rgba(255,255,255,0.8)" />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontFamily: 'Hanken Grotesk, sans-serif',
              fontSize: 15,
              fontWeight: 700,
              color: '#fff',
              lineHeight: 1.2,
            }}
          >
            Recent Chats
          </div>
          <div
            style={{
              fontFamily: 'Inter, sans-serif',
              fontSize: 11,
              color: 'rgba(255,255,255,0.65)',
              marginTop: 1,
            }}
          >
            Stored for 30 days
          </div>
        </div>
      </div>

      {/* Sessions list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 8px' }}>
        {sessions.length === 0 ? (
          <div
            style={{
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
                width: 48,
                height: 48,
                borderRadius: '50%',
                background: '#F5F3FF',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon name="chat_bubble_outline" size={22} color="#9d8dff" />
            </div>
            <div
              style={{
                fontFamily: 'Inter, sans-serif',
                fontSize: 13,
                color: '#787584',
                textAlign: 'center',
              }}
            >
              No previous chats yet
            </div>
          </div>
        ) : (
          groups.map(({ label, items }) => (
            <div key={label} style={{ marginBottom: 4 }}>
              <div
                style={{
                  fontFamily: 'Inter, sans-serif',
                  fontSize: 10.5,
                  fontWeight: 600,
                  color: '#b0acbe',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  padding: '8px 8px 4px',
                }}
              >
                {label}
              </div>
              {items.map((session) => (
                <div
                  key={session.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    borderRadius: 10,
                    padding: '8px 10px',
                    cursor: 'pointer',
                    transition: 'background 120ms',
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = '#F5F3FF'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
                >
                  <div
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 8,
                      background: '#ede9ff',
                      flexShrink: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Icon name="chat" size={15} color="#7c6de8" />
                  </div>
                  <div
                    style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}
                    onClick={() => onSelect(session.id)}
                  >
                    <div
                      style={{
                        fontFamily: 'Inter, sans-serif',
                        fontSize: 13,
                        color: '#1c1b22',
                        fontWeight: 500,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {session.title ?? 'New conversation'}
                    </div>
                    <div
                      style={{
                        fontFamily: 'Inter, sans-serif',
                        fontSize: 11,
                        color: '#b0acbe',
                        marginTop: 1,
                      }}
                    >
                      {new Date(session.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); onDelete(session.id); }}
                    title="Delete chat"
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: 6,
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                      opacity: 0.5,
                      transition: 'opacity 120ms',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.background = '#ffeaea'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.5'; e.currentTarget.style.background = 'transparent'; }}
                  >
                    <Icon name="delete" size={14} color="#ba1a1a" />
                  </button>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
