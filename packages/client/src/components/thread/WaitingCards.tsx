import { Loader2, Clock, CheckCircle2, XCircle, Send, ShieldQuestion } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

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
    <div className="space-y-2.5 rounded-lg border border-status-warning/20 bg-status-warning/5 p-3">
      <div className="flex items-center gap-2 text-xs text-status-warning/80">
        <Clock className="icon-sm" />
        {t('thread.waitingForResponse')}
      </div>

      <div className="flex gap-2">
        <button
          data-testid="waiting-accept"
          onClick={() => onSend('Continue')}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <CheckCircle2 className="icon-sm" />
          {t('thread.acceptContinue')}
        </button>
        <button
          data-testid="waiting-reject"
          onClick={() => onSend('No, do not proceed with that action.')}
          className="flex items-center gap-1.5 rounded-md border border-border bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
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
  onApprove,
  onDeny,
}: {
  toolName: string;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState<'approve' | 'deny' | null>(null);

  const handleApprove = () => {
    setLoading('approve');
    onApprove();
  };

  const handleDeny = () => {
    setLoading('deny');
    onDeny();
  };

  return (
    <div className="space-y-2.5 rounded-lg border border-status-warning/20 bg-status-warning/5 p-3">
      <div className="flex items-center gap-2 text-xs text-status-warning/80">
        <ShieldQuestion className="icon-sm" />
        {t('thread.permissionRequired')}
      </div>
      <p className="text-xs text-foreground">{t('thread.permissionMessage', { tool: toolName })}</p>
      <div className="flex gap-2">
        <button
          data-testid="permission-approve"
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
          {t('thread.approvePermission')}
        </button>
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
