import {
  Loader2,
  Clock,
  CheckCircle2,
  XCircle,
  Send,
  ShieldCheck,
  ShieldQuestion,
} from 'lucide-react';
import { useState, useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ensureLanguage, highlightCode } from '@/hooks/use-highlight';
import { cn } from '@/lib/utils';
import { CODE_FONT_SIZE_PX, CODE_LINE_HEIGHT_PX, useSettingsStore } from '@/stores/settings-store';

export function WaitingActions({ onSend }: { onSend: (text: string) => void }) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmitInput = () => {
    const text = input.trim();
    if (!text) return;
    onSend(text);
    setInput('');
  };

  return (
    <div className="border-status-warning/20 bg-status-warning/5 space-y-2.5 rounded-lg border p-3">
      <div className="text-status-warning/80 flex items-center gap-2 text-xs">
        <Clock className="icon-sm" />
        {t('thread.waitingForResponse')}
      </div>

      <div className="flex gap-2">
        <button
          data-testid="waiting-accept"
          onClick={() => onSend('Continue')}
          className="bg-primary text-primary-foreground hover:bg-primary/90 flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
        >
          <CheckCircle2 className="icon-sm" />
          {t('thread.acceptContinue')}
        </button>
        <button
          data-testid="waiting-reject"
          onClick={() => onSend('No, do not proceed with that action.')}
          className="border-border bg-muted text-muted-foreground hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors"
        >
          <XCircle className="icon-sm" />
          {t('thread.reject')}
        </button>
      </div>

      <div className="flex gap-2">
        <Input
          ref={inputRef}
          data-testid="waiting-response-input"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSubmitInput();
            }
          }}
          placeholder={t('thread.waitingInputPlaceholder')}
          className="h-auto flex-1 py-1.5"
        />
        <button
          data-testid="waiting-send"
          onClick={handleSubmitInput}
          disabled={!input.trim()}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
            input.trim()
              ? 'bg-primary text-primary-foreground hover:bg-primary/90'
              : 'bg-muted text-muted-foreground cursor-not-allowed',
          )}
        >
          <Send className="icon-xs" />
          {t('thread.send')}
        </button>
      </div>
    </div>
  );
}

export function PermissionApprovalCard({
  toolName,
  toolInput,
  onApprove,
  onAlwaysAllow,
  onDeny,
}: {
  toolName: string;
  toolInput?: string;
  onApprove: () => void;
  onAlwaysAllow?: () => void;
  onDeny: () => void;
}) {
  const { t } = useTranslation();
  const fontSize = useSettingsStore((s) => s.fontSize);
  const [loading, setLoading] = useState<'approve' | 'always' | 'deny' | null>(null);
  const [showFullInput, setShowFullInput] = useState(false);

  const bashCommand = useMemo(() => {
    if (toolName !== 'Bash' || !toolInput) return null;
    try {
      const parsed = JSON.parse(toolInput) as { command?: unknown };
      return typeof parsed.command === 'string' ? parsed.command : null;
    } catch {
      return null;
    }
  }, [toolName, toolInput]);

  const rawInput = bashCommand ?? toolInput;
  const TRUNCATE_LIMIT = 400;
  const isLongInput = !!rawInput && rawInput.length > TRUNCATE_LIMIT;
  const displayedInput = rawInput
    ? showFullInput || !isLongInput
      ? rawInput
      : rawInput.slice(0, TRUNCATE_LIMIT) + '…'
    : undefined;

  const [highlightedBash, setHighlightedBash] = useState<string | null>(null);
  useEffect(() => {
    if (!displayedInput || !bashCommand) {
      setHighlightedBash(null);
      return;
    }
    let cancelled = false;
    ensureLanguage('bash').then(() => {
      if (!cancelled) setHighlightedBash(highlightCode(displayedInput, 'bash'));
    });
    return () => {
      cancelled = true;
    };
  }, [displayedInput, bashCommand]);

  const handleApprove = () => {
    setLoading('approve');
    onApprove();
  };

  const handleAlwaysAllow = () => {
    setLoading('always');
    onAlwaysAllow?.();
  };

  const handleDeny = () => {
    setLoading('deny');
    onDeny();
  };

  return (
    <div className="border-status-warning/20 bg-status-warning/5 space-y-2.5 rounded-lg border p-3">
      <div className="text-status-warning/80 flex items-center gap-2 text-xs">
        <ShieldQuestion className="icon-sm" />
        {t('thread.permissionRequired')}
      </div>
      <p className="text-foreground text-xs">{t('thread.permissionMessage', { tool: toolName })}</p>
      {displayedInput && (
        <div className="space-y-1">
          {bashCommand && highlightedBash ? (
            <ScrollArea className="bg-muted max-h-32 rounded">
              <pre
                data-testid="permission-card-tool-input"
                style={{
                  fontSize: `${CODE_FONT_SIZE_PX[fontSize]}px`,
                  lineHeight: `${CODE_LINE_HEIGHT_PX[fontSize]}px`,
                }}
                className="hljs p-2 font-mono break-all whitespace-pre-wrap"
                dangerouslySetInnerHTML={{ __html: highlightedBash }}
              />
            </ScrollArea>
          ) : (
            <ScrollArea className="bg-muted max-h-32 rounded">
              <pre
                data-testid="permission-card-tool-input"
                style={{
                  fontSize: `${CODE_FONT_SIZE_PX[fontSize]}px`,
                  lineHeight: `${CODE_LINE_HEIGHT_PX[fontSize]}px`,
                }}
                className="text-muted-foreground p-2 font-mono break-all whitespace-pre-wrap"
              >
                {displayedInput}
              </pre>
            </ScrollArea>
          )}
          {isLongInput && (
            <button
              data-testid="permission-card-tool-input-toggle"
              onClick={() => setShowFullInput((v) => !v)}
              className="text-muted-foreground hover:text-foreground text-xs underline"
            >
              {showFullInput ? t('common.showLess') : t('common.showMore')}
            </button>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          data-testid="permission-approve-once"
          onClick={handleApprove}
          disabled={!!loading}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors',
            loading && 'opacity-50 pointer-events-none',
          )}
        >
          {loading === 'approve' ? (
            <Loader2 className="icon-sm animate-spin" />
          ) : (
            <CheckCircle2 className="icon-sm" />
          )}
          {t('thread.approveJustOnce')}
        </button>
        {onAlwaysAllow && (
          <button
            data-testid="permission-approve-always"
            onClick={handleAlwaysAllow}
            disabled={!!loading}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-primary/80 text-primary-foreground hover:bg-primary/70 transition-colors',
              loading && 'opacity-50 pointer-events-none',
            )}
          >
            {loading === 'always' ? (
              <Loader2 className="icon-sm animate-spin" />
            ) : (
              <ShieldCheck className="icon-sm" />
            )}
            {t('thread.alwaysAllow')}
          </button>
        )}
        <button
          data-testid="permission-deny"
          onClick={handleDeny}
          disabled={!!loading}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-border bg-muted text-muted-foreground hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30 transition-colors',
            loading && 'opacity-50 pointer-events-none',
          )}
        >
          {loading === 'deny' ? (
            <Loader2 className="icon-sm animate-spin" />
          ) : (
            <XCircle className="icon-sm" />
          )}
          {t('thread.denyPermission')}
        </button>
      </div>
    </div>
  );
}
