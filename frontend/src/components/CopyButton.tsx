import { useState } from 'react';
import Icon from './Icon';

interface CopyButtonProps {
  /** Text to copy to the clipboard. The button is hidden by the caller when empty. */
  text: string;
  title?: string;
  size?: number;
}

/** Tiny clipboard-copy button with a brief check-mark confirmation. */
export default function CopyButton({ text, title = 'Copy to clipboard', size = 14 }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!text) return;
    navigator.clipboard.writeText(text)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); })
      .catch(() => {});
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={copied ? 'Copied!' : title}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 26, height: 26, borderRadius: 7, border: 'none',
        background: copied ? 'rgba(16,185,129,0.1)' : 'transparent',
        cursor: 'pointer', transition: 'background 150ms', flexShrink: 0,
      }}
      onMouseEnter={e => { if (!copied) e.currentTarget.style.background = '#F5F3FF'; }}
      onMouseLeave={e => { if (!copied) e.currentTarget.style.background = 'transparent'; }}
    >
      <span key={copied ? 'copied' : 'idle'} style={{ display: 'inline-flex', animation: copied ? 'savedPop 280ms cubic-bezier(0.34,1.56,0.64,1) both' : undefined }}>
        <Icon name={copied ? 'check' : 'content_copy'} size={size} color={copied ? '#10B981' : '#9d8dff'} />
      </span>
    </button>
  );
}
