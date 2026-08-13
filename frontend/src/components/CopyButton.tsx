import { useState } from 'react';
import Icon from './Icon';
import { motion } from './animate-ui/motion';
import { EASE_SPRING } from './animate-ui/motionTokens';
import MotionButton from './animate-ui/MotionButton';

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
    <MotionButton
      type="button"
      onClick={handleCopy}
      title={copied ? 'Copied!' : title}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 26, height: 26, borderRadius: 7, border: 'none',
        cursor: 'pointer', flexShrink: 0,
      }}
      animate={{ background: copied ? 'rgba(var(--color-success-rgb), 0.1)' : 'rgba(0,0,0,0)' }}
      whileHover={copied ? undefined : { background: 'var(--color-surface-tint)' }}
      transition={{ duration: 0.15 }}
    >
      <motion.span
        key={copied ? 'copied' : 'idle'}
        initial={copied ? { scale: 0.6, opacity: 0 } : false}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.28, ease: EASE_SPRING }}
        style={{ display: 'inline-flex' }}>
        <Icon name={copied ? 'check' : 'content_copy'} size={size} color={copied ? 'var(--color-success)' : 'var(--color-accent-purple-light)'} />
      </motion.span>
    </MotionButton>
  );
}
