import { CheckCircle2, XCircle, Clock, AlertTriangle, Play } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

function formatDuration(ms: number, t: (key: string, opts?: any) => string): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return t('duration.seconds', { count: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const remainingSeconds = seconds % 60;
    return t('duration.minutesSeconds', { minutes, seconds: remainingSeconds });
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return t('duration.hoursMinutes', { hours, minutes: remainingMinutes });
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
          <CheckCircle2 className="icon-base text-status-success/80 shrink-0" />
        ) : (
          <AlertTriangle className="icon-base text-status-interrupted/80 shrink-0" />
        )}
        <span
          className={cn(
            'font-medium',
            isSuccess ? 'text-status-success/80' : 'text-status-interrupted/80',
          )}
        >
          {isSuccess ? t('thread.taskCompleted') : t('thread.taskFailed')}
        </span>
        <div className="text-muted-foreground ml-auto flex items-center gap-3">
          {duration > 0 && (
            <span className="flex items-center gap-1">
              <Clock className="icon-xs" />
              {formatDuration(duration, t)}
            </span>
          )}
          {!isSuccess && onContinue && (
            <button
              onClick={onContinue}
              className="bg-primary text-primary-foreground hover:bg-primary/90 flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
            >
              <Play className="icon-xs" />
              {t('thread.acceptContinue')}
            </button>
          )}
        </div>
      </div>
      {!isSuccess && error && (
        <pre className="text-status-interrupted/80 overflow-x-auto pl-7 font-mono text-[10px] whitespace-pre-wrap">
          {error}
        </pre>
      )}
    </div>
  );
}

export function AgentInterruptedCard({ onContinue }: { onContinue?: () => void }) {
  const { t } = useTranslation();

  return (
    <div className="border-status-interrupted/20 bg-status-interrupted/5 flex items-center gap-3 rounded-lg border px-3 py-2 text-xs">
      <AlertTriangle className="icon-base text-status-interrupted/80 shrink-0" />
      <div>
        <span className="text-status-interrupted/80 font-medium">
          {t('thread.taskInterrupted')}
        </span>
        <p className="text-muted-foreground mt-0.5">{t('thread.serverRestarted')}</p>
      </div>
      {onContinue && (
        <button
          onClick={onContinue}
          className="bg-primary text-primary-foreground hover:bg-primary/90 ml-auto flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
        >
          <Play className="icon-xs" />
          {t('thread.acceptContinue')}
        </button>
      )}
    </div>
  );
}

export function AgentStoppedCard({ onContinue }: { onContinue?: () => void }) {
  const { t } = useTranslation();

  return (
    <div className="border-status-info/20 bg-status-info/5 flex items-center gap-3 rounded-lg border px-3 py-2 text-xs">
      <XCircle className="icon-base text-status-info/80 shrink-0" />
      <div>
        <span className="text-status-info/80 font-medium">{t('thread.taskStopped')}</span>
        <p className="text-muted-foreground mt-0.5">{t('thread.manuallyStopped')}</p>
      </div>
      {onContinue && (
        <button
          onClick={onContinue}
          className="bg-primary text-primary-foreground hover:bg-primary/90 ml-auto flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
        >
          <Play className="icon-xs" />
          {t('thread.acceptContinue')}
        </button>
      )}
    </div>
  );
}
