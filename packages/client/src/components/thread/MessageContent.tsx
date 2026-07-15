import { Check, Copy } from 'lucide-react';
import { memo } from 'react';

import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';

import { SatteriMessageContent } from './SatteriMessageContent';

/**
 * The sole thread markdown renderer. Sätteri emits sanitized HTML; a WASM
 * failure preserves the source as plain text rather than switching engines.
 */
export const MessageContent = memo(function MessageContent({ content }: { content: string }) {
  return <SatteriMessageContent content={content} />;
});

export function CopyButton({ content }: { content: string }) {
  const [copied, copy] = useCopyToClipboard();

  return (
    <button
      type="button"
      onClick={() => copy(content)}
      className="msg-copy-btn text-muted-foreground hover:bg-muted hover:text-foreground shrink-0 rounded p-1 opacity-0 transition-opacity group-hover/msg:opacity-100"
      aria-label="Copy message"
      data-testid="message-copy"
    >
      {copied ? <Check className="icon-sm" /> : <Copy className="icon-sm" />}
    </button>
  );
}
