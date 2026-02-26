import { CheckCircle2, XCircle, Clock, AlertTriangle, Play } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

function formatDuration(ms: number, t: (key: string, opts?: any) => string): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return t('duration.seconds', { count: seconds });
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return t('duration.minutesSeconds', { minutes, seconds: remainingSeconds });
}

export function AgentResultCard({
  status,
  cost: _cost,
  duration,
  error,
  onContinue,
}: {
  status: 'completed' | 'failed';
  cost: number;
  duration: number;
  error?: string;
  onContinue?: () => void;
}) {
  const { t } = useTranslation();
  const isSuccess = status === 'completed';

  return (
    <div
      className={cn(
        'rounded-lg border px-3 py-2 text-xs flex flex-col gap-2',
        isSuccess
          ? 'border-status-success/20 bg-status-success/5'
          : 'border-status-interrupted/20 bg-status-interrupted/5',
      )}
    >
      <div className="flex items-center gap-3">
        {isSuccess ? (
          <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-status-success/80" />
        ) : (
          <AlertTriangle className="h-4 w-4 flex-shrink-0 text-status-interrupted/80" />
        )}
        <span
          className={cn(
            'font-medium',
            isSuccess ? 'text-status-success/80' : 'text-status-interrupted/80',
          )}
        >
          {isSuccess ? t('thread.taskCompleted') : t('thread.taskFailed')}
        </span>
        <div className="ml-auto flex items-center gap-3 text-muted-foreground">
          {duration > 0 && (
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {formatDuration(duration, t)}
            </span>
          )}
          {!isSuccess && onContinue && (
            <button
              onClick={onContinue}
              className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              <Play className="h-3 w-3" />
              {t('thread.acceptContinue')}
            </button>
          )}
        </div>
      </div>
      {!isSuccess && error && (
        <pre className="overflow-x-auto whitespace-pre-wrap pl-7 font-mono text-[10px] text-status-interrupted/80">
          {error}
        </pre>
      )}
    </div>
  );
}

export function AgentInterruptedCard({ onContinue }: { onContinue?: () => void }) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center gap-3 rounded-lg border border-status-interrupted/20 bg-status-interrupted/5 px-3 py-2 text-xs">
      <AlertTriangle className="h-4 w-4 flex-shrink-0 text-status-interrupted/80" />
      <div>
        <span className="font-medium text-status-interrupted/80">
          {t('thread.taskInterrupted')}
        </span>
        <p className="mt-0.5 text-muted-foreground">{t('thread.serverRestarted')}</p>
      </div>
      {onContinue && (
        <button
          onClick={onContinue}
          className="ml-auto flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <Play className="h-3 w-3" />
          {t('thread.acceptContinue')}
        </button>
      )}
    </div>
  );
}

export function AgentStoppedCard({ onContinue }: { onContinue?: () => void }) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center gap-3 rounded-lg border border-status-info/20 bg-status-info/5 px-3 py-2 text-xs">
      <XCircle className="h-4 w-4 flex-shrink-0 text-status-info/80" />
      <div>
        <span className="font-medium text-status-info/80">{t('thread.taskStopped')}</span>
        <p className="mt-0.5 text-muted-foreground">{t('thread.manuallyStopped')}</p>
      </div>
      {onContinue && (
        <button
          onClick={onContinue}
          className="ml-auto flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <Play className="h-3 w-3" />
          {t('thread.acceptContinue')}
        </button>
      )}
    </div>
  );
}
