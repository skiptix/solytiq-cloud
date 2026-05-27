import type { AISession } from '../../store/useAIStore';
import Icon from '../Icon';

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
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: '#fff',
        borderRadius: 20,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        zIndex: 15,
        animation: 'aiPanelIn 260ms cubic-bezier(0.22,1,0.36,1) both',
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
            width: 30,
            height: 30,
            borderRadius: 8,
            background: 'rgba(255,255,255,0.12)',
            border: 'none',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            transition: 'background 180ms ease, transform 150ms ease',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.24)'; e.currentTarget.style.transform = 'scale(1.08)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.12)'; e.currentTarget.style.transform = 'scale(1)'; }}
        >
          <Icon name="arrow_back" size={15} color="rgba(255,255,255,0.85)" />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontFamily: 'Hanken Grotesk, sans-serif',
              fontSize: 15,
              fontWeight: 700,
              color: '#fff',
              lineHeight: 1.2,
              letterSpacing: '-0.01em',
            }}
          >
            Recent Chats
          </div>
          <div
            style={{
              fontFamily: 'Inter, sans-serif',
              fontSize: 11,
              color: 'rgba(255,255,255,0.6)',
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
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              gap: 10,
              padding: 24,
              animation: 'aiFadeIn 300ms ease both',
            }}
          >
            <div
              style={{
                width: 52,
                height: 52,
                borderRadius: '50%',
                background: 'linear-gradient(135deg, #ede9ff 0%, #f5f3ff 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 4px 16px rgba(107,91,204,0.12)',
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
                lineHeight: 1.5,
              }}
            >
              No previous chats yet.<br />Start a conversation with Sol!
            </div>
          </div>
        ) : (
          groups.map(({ label, items }, groupIdx) => (
            <div key={label}>
              <div
                style={{
                  fontFamily: 'Inter, sans-serif',
                  fontSize: 10.5,
                  fontWeight: 600,
                  color: '#b0acbe',
                  textTransform: 'uppercase',
                  letterSpacing: '0.07em',
                  padding: '10px 8px 4px',
                  animation: `aiItemIn 280ms ease ${groupIdx * 40}ms both`,
                }}
              >
                {label}
              </div>
              {items.map((session, itemIdx) => {
                const delay = groupIdx * 40 + itemIdx * 35 + 40;
                return (
                  <div
                    key={session.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      borderRadius: 12,
                      padding: '9px 10px',
                      cursor: 'pointer',
                      transition: 'background 180ms ease, transform 150ms ease',
                      animation: `aiItemIn 280ms ease ${delay}ms both`,
                    }}
                    onClick={() => onSelect(session.id)}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = '#F5F3FF'; (e.currentTarget as HTMLDivElement).style.transform = 'translateX(2px)'; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; (e.currentTarget as HTMLDivElement).style.transform = 'translateX(0)'; }}
                  >
                    <div
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: 10,
                        background: 'linear-gradient(135deg, #ede9ff 0%, #e4dfff 100%)',
                        flexShrink: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Icon name="chat" size={15} color="#7c6de8" />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontFamily: 'Inter, sans-serif',
                          fontSize: 13,
                          color: '#1c1b22',
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
                          fontFamily: 'Inter, sans-serif',
                          fontSize: 11,
                          color: '#b0acbe',
                          marginTop: 2,
                        }}
                      >
                        {new Date(session.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </div>
                    <button
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
                        opacity: 0,
                        transition: 'opacity 180ms ease, background 180ms ease, transform 150ms ease',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = '#fff0f0'; e.currentTarget.style.transform = 'scale(1.1)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.transform = 'scale(1)'; }}
                      // Show delete on parent hover via CSS would need a class; instead show always with low opacity
                      ref={(el) => {
                        if (el) el.style.opacity = '0.4';
                      }}
                    >
                      <Icon name="delete" size={14} color="#ba1a1a" />
                    </button>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
