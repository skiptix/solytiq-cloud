import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { AIChatMessage } from '../../store/useAIStore';
import Icon from '../Icon';

interface Props {
  messages: AIChatMessage[];
  isThinking: boolean;
  contextView: string;
  onSend: (text: string) => void;
  onClose: () => void;
  onClearHistory: () => void;
  onShowRecentChats: () => void;
}

const VIEW_LABELS: Record<string, string> = {
  dashboard: 'Dashboard',
  list: 'List',
  scheduled: 'Scheduled',
  files: 'Files',
  settings: 'Settings',
  general: 'App',
};

function ThinkingDots() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '10px 14px' }}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: '#9d8dff',
            display: 'inline-block',
            animation: `aiDotBounce 1.2s ease-in-out ${i * 0.2}s infinite`,
          }}
        />
      ))}
    </div>
  );
}

function UserMessage({ msg }: { msg: AIChatMessage }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
      <div
        style={{
          maxWidth: '78%',
          background: 'linear-gradient(135deg, #6b5bcc 0%, #4a39aa 100%)',
          color: '#fff',
          borderRadius: '18px 18px 4px 18px',
          padding: '10px 14px',
          fontFamily: 'Inter, sans-serif',
          fontSize: 13.5,
          lineHeight: 1.5,
          wordBreak: 'break-word',
        }}
      >
        {msg.content}
      </div>
    </div>
  );
}

function AssistantMessage({ msg }: { msg: AIChatMessage }) {
  if (msg.isThinking) {
    return (
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, marginBottom: 10 }}>
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: '50%',
            background: 'linear-gradient(135deg, #9d8dff 0%, #4a39aa 100%)',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <span style={{ fontSize: 14 }}>✦</span>
        </div>
        <div
          style={{
            background: '#F5F3FF',
            borderRadius: '4px 18px 18px 18px',
            border: '1px solid #e8e4f0',
          }}
        >
          <ThinkingDots />
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 10 }}>
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: '50%',
          background: 'linear-gradient(135deg, #9d8dff 0%, #4a39aa 100%)',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginTop: 2,
        }}
      >
        <span style={{ fontSize: 14 }}>✦</span>
      </div>
      <div style={{ maxWidth: 'calc(100% - 36px)', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {msg.actionSummary && (
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              background: 'rgba(16,185,129,0.1)',
              border: '1px solid rgba(16,185,129,0.25)',
              borderRadius: 8,
              padding: '4px 10px',
              fontFamily: 'Inter, sans-serif',
              fontSize: 11.5,
              fontWeight: 600,
              color: '#059669',
            }}
          >
            <Icon name="check_circle" size={13} color="#059669" />
            {msg.actionSummary}
          </div>
        )}
        {msg.content && (
          <div
            style={{
              background: msg.error ? '#fff5f5' : '#F5F3FF',
              border: `1px solid ${msg.error ? '#ffdad6' : '#e8e4f0'}`,
              borderRadius: '4px 18px 18px 18px',
              padding: '10px 14px',
              fontFamily: 'Inter, sans-serif',
              fontSize: 13.5,
              lineHeight: 1.6,
              color: msg.error ? '#ba1a1a' : '#1c1b22',
              wordBreak: 'break-word',
            }}
          >
            <ReactMarkdown
              components={{
                p: ({ children }) => <p style={{ margin: '0 0 6px', lineHeight: 1.6 }}>{children}</p>,
                ul: ({ children }) => <ul style={{ margin: '4px 0 6px', paddingLeft: 18 }}>{children}</ul>,
                ol: ({ children }) => <ol style={{ margin: '4px 0 6px', paddingLeft: 18 }}>{children}</ol>,
                li: ({ children }) => <li style={{ marginBottom: 3, lineHeight: 1.5 }}>{children}</li>,
                strong: ({ children }) => <strong style={{ fontWeight: 700, color: 'inherit' }}>{children}</strong>,
                em: ({ children }) => <em style={{ fontStyle: 'italic' }}>{children}</em>,
                code: ({ children, className }) => {
                  const isBlock = className?.includes('language-');
                  return isBlock ? (
                    <pre style={{ background: 'rgba(0,0,0,0.06)', borderRadius: 6, padding: '8px 10px', overflow: 'auto', margin: '6px 0', fontSize: 12 }}>
                      <code style={{ fontFamily: 'monospace', fontSize: 12 }}>{children}</code>
                    </pre>
                  ) : (
                    <code style={{ background: 'rgba(0,0,0,0.07)', borderRadius: 4, padding: '1px 5px', fontFamily: 'monospace', fontSize: 12.5 }}>{children}</code>
                  );
                },
                h1: ({ children }) => <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontWeight: 700, fontSize: 15, margin: '6px 0 4px' }}>{children}</div>,
                h2: ({ children }) => <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontWeight: 700, fontSize: 14, margin: '6px 0 4px' }}>{children}</div>,
                h3: ({ children }) => <div style={{ fontFamily: 'Hanken Grotesk, sans-serif', fontWeight: 600, fontSize: 13.5, margin: '4px 0 4px' }}>{children}</div>,
                a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: '#5e4dbb', textDecoration: 'underline' }}>{children}</a>,
                blockquote: ({ children }) => <blockquote style={{ borderLeft: '3px solid #c9c4d5', paddingLeft: 10, margin: '6px 0', color: '#787584', fontStyle: 'italic' }}>{children}</blockquote>,
                hr: () => <hr style={{ border: 'none', borderTop: '1px solid #e8e4f0', margin: '8px 0' }} />,
              }}
            >
              {msg.content}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}

export default function AIChatWindow({ messages, isThinking, contextView, onSend, onClose, onClearHistory, onShowRecentChats }: Props) {
  const [input, setInput] = useState('');
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSend = () => {
    const text = input.trim();
    if (!text || isThinking) return;
    setInput('');
    onSend(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const viewLabel = VIEW_LABELS[contextView] ?? contextView;

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 64,
        right: 0,
        width: 360,
        height: 500,
        background: '#fff',
        borderRadius: 20,
        boxShadow: '0 16px 48px rgba(30,20,80,0.22), 0 2px 8px rgba(94,77,187,0.12)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        animation: 'aiWindowIn 250ms cubic-bezier(0.34,1.56,0.64,1) both',
        border: '1px solid rgba(94,77,187,0.15)',
      }}
      onClick={(e) => e.stopPropagation()}
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
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: '50%',
            background: 'rgba(255,255,255,0.2)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 16,
            flexShrink: 0,
          }}
        >
          ✦
        </div>
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
            Sol
          </div>
          <div
            style={{
              fontFamily: 'Inter, sans-serif',
              fontSize: 11,
              color: 'rgba(255,255,255,0.65)',
              marginTop: 1,
            }}
          >
            {viewLabel} context
          </div>
        </div>
        {/* Recent chats */}
        <button
          onClick={onShowRecentChats}
          title="Recent chats"
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
            transition: 'background 120ms',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.22)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.12)'; }}
        >
          <Icon name="history" size={15} color="rgba(255,255,255,0.8)" />
        </button>
        {/* Clear */}
        <button
          onClick={() => setShowClearConfirm(true)}
          title="Clear chat history"
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
            transition: 'background 120ms',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.22)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.12)'; }}
        >
          <Icon name="delete_sweep" size={15} color="rgba(255,255,255,0.8)" />
        </button>
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
            transition: 'background 120ms',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.22)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.12)'; }}
        >
          <Icon name="close" size={15} color="rgba(255,255,255,0.8)" />
        </button>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '14px 14px 4px',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {messages.length === 0 && (
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              padding: '20px 10px',
            }}
          >
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: '50%',
                background: '#F5F3FF',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 28,
              }}
            >
              ✦
            </div>
            <div
              style={{
                fontFamily: 'Hanken Grotesk, sans-serif',
                fontSize: 15,
                fontWeight: 600,
                color: '#1c1b22',
                textAlign: 'center',
              }}
            >
              Hi, I'm Sol — how can I help?
            </div>
            <div
              style={{
                fontFamily: 'Inter, sans-serif',
                fontSize: 12.5,
                color: '#787584',
                textAlign: 'center',
                lineHeight: 1.5,
                maxWidth: 260,
              }}
            >
              I can add, edit or delete tasks and sections based on what you're working on.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4, width: '100%', maxWidth: 280 }}>
              {[
                contextView === 'list' ? 'Add a task to the first section' : 'Add a task called "Weekly review"',
                contextView === 'scheduled' ? 'Schedule the top priority task for tomorrow' : 'Mark all overdue tasks as done',
                contextView === 'list' ? 'Create a section called "In Review"' : 'What tasks are due today?',
              ].map((hint) => (
                <button
                  key={hint}
                  onClick={() => { setInput(hint); inputRef.current?.focus(); }}
                  style={{
                    fontFamily: 'Inter, sans-serif',
                    fontSize: 12,
                    color: '#5e4dbb',
                    background: '#F5F3FF',
                    border: '1px solid #e8e4f0',
                    borderRadius: 10,
                    padding: '7px 12px',
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'background 120ms',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = '#ede9ff'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = '#F5F3FF'; }}
                >
                  {hint}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((msg) =>
          msg.role === 'user' ? (
            <UserMessage key={msg.id} msg={msg} />
          ) : (
            <AssistantMessage key={msg.id} msg={msg} />
          )
        )}
      </div>

      {/* Input */}
      <div
        style={{
          padding: '10px 12px 14px',
          borderTop: '1px solid #f1ecf6',
          flexShrink: 0,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            gap: 8,
            background: '#F9FAFB',
            border: '1.5px solid #e8e4f0',
            borderRadius: 14,
            padding: '8px 8px 8px 12px',
            transition: 'border-color 200ms',
          }}
        >
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message Sol…"
            rows={1}
            disabled={isThinking}
            style={{
              flex: 1,
              fontFamily: 'Inter, sans-serif',
              fontSize: 13.5,
              color: '#1c1b22',
              background: 'transparent',
              border: 'none',
              outline: 'none',
              resize: 'none',
              lineHeight: 1.5,
              maxHeight: 96,
              overflowY: 'auto',
              opacity: isThinking ? 0.5 : 1,
            }}
            onInput={(e) => {
              const t = e.currentTarget;
              t.style.height = 'auto';
              t.style.height = `${Math.min(t.scrollHeight, 96)}px`;
            }}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isThinking}
            style={{
              width: 32,
              height: 32,
              borderRadius: 10,
              background:
                !input.trim() || isThinking
                  ? '#e8e4f0'
                  : 'linear-gradient(135deg, #6b5bcc 0%, #4a39aa 100%)',
              border: 'none',
              cursor: !input.trim() || isThinking ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              transition: 'all 150ms',
            }}
          >
            <Icon
              name="arrow_upward"
              size={16}
              color={!input.trim() || isThinking ? '#b0acbe' : '#fff'}
            />
          </button>
        </div>
        <div
          style={{
            fontFamily: 'Inter, sans-serif',
            fontSize: 10.5,
            color: '#b0acbe',
            marginTop: 5,
            textAlign: 'center',
          }}
        >
          Enter to send · Shift+Enter for new line
        </div>
      </div>

      {/* Clear history confirmation */}
      {showClearConfirm && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(255,255,255,0.92)',
            backdropFilter: 'blur(4px)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 14,
            padding: 24,
            borderRadius: 20,
            zIndex: 10,
          }}
        >
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: '50%',
              background: '#fff5f5',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name="delete_sweep" size={22} color="#ba1a1a" />
          </div>
          <div style={{ textAlign: 'center' }}>
            <div
              style={{
                fontFamily: 'Hanken Grotesk, sans-serif',
                fontSize: 15,
                fontWeight: 700,
                color: '#1c1b22',
                marginBottom: 6,
              }}
            >
              Clear this chat?
            </div>
            <div
              style={{
                fontFamily: 'Inter, sans-serif',
                fontSize: 12.5,
                color: '#787584',
                lineHeight: 1.5,
              }}
            >
              Messages will be permanently deleted.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, width: '100%' }}>
            <button
              onClick={() => setShowClearConfirm(false)}
              style={{
                flex: 1,
                fontFamily: 'Hanken Grotesk, sans-serif',
                fontSize: 13,
                fontWeight: 500,
                color: '#484552',
                background: '#f1ecf6',
                border: 'none',
                borderRadius: 10,
                padding: '10px 0',
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = '#e8e4f0'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = '#f1ecf6'; }}
            >
              Cancel
            </button>
            <button
              onClick={() => { setShowClearConfirm(false); onClearHistory(); }}
              style={{
                flex: 1,
                fontFamily: 'Hanken Grotesk, sans-serif',
                fontSize: 13,
                fontWeight: 600,
                color: '#fff',
                background: '#ba1a1a',
                border: 'none',
                borderRadius: 10,
                padding: '10px 0',
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = '#991212'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = '#ba1a1a'; }}
            >
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
