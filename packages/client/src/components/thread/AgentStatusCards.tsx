import { CheckCircle2, XCircle, Clock, AlertTriangle, Play } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

import { CopyThreadButton } from './CopyThreadButton';

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

/** Live runs report their duration; reloaded threads derive it from the turn bounds. */
function resolveDuration(duration: number, startedAt?: string | null, completedAt?: string | null) {
  if (duration > 0) return duration;
  if (!startedAt || !completedAt) return 0;
  const elapsed = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  return Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
}

interface RunMetaProps {
  /** Render the completion time in the meta row (cards without it in their title). */
  showTime?: boolean;
  duration?: number;
  startedAt?: string | null;
  completedAt?: string | null;
  copyThreadId?: string;
  /** In-memory turn to copy instead of fetching the thread's latest turn. */
  copyMessages?: Parameters<typeof CopyThreadButton>[0]['messages'];
}

function parseTime(value?: string | null) {
  const date = value ? new Date(value) : undefined;
  return date && !Number.isNaN(date.getTime()) ? date : undefined;
}

function CompletionTime({ completedAt }: { completedAt?: string | null }) {
  const finished = parseTime(completedAt);
  if (!finished) return null;
  return (
    <time dateTime={finished.toISOString()} title={finished.toLocaleString()}>
      {finished.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
    </time>
  );
}

/** Completion time, processing time and copy action shared by every end-of-run card. */
function RunMeta({
  showTime = false,
  duration = 0,
  startedAt,
  completedAt,
  copyThreadId,
  copyMessages,
}: RunMetaProps) {
  const { t } = useTranslation();
  const elapsed = resolveDuration(duration, startedAt, completedAt);

  return (
    <>
      {showTime && <CompletionTime completedAt={completedAt} />}
      {elapsed > 0 && (
        <span className="flex items-center gap-1" data-testid="agent-run-duration">
          <Clock className="icon-xs" />
          {formatDuration(elapsed, t)}
        </span>
      )}
      {copyThreadId && (
        <CopyThreadButton key={copyThreadId} threadId={copyThreadId} messages={copyMessages} />
      )}
    </>
  );
}

const RESULT_LABEL = {
  completed: 'thread.taskCompleted',
  failed: 'thread.taskFailed',
  stopped: 'thread.taskStopped',
} as const;
const RESULT_LABEL_AT = {
  completed: 'thread.taskCompletedAt',
  failed: 'thread.taskFailedAt',
  stopped: 'thread.taskStoppedAt',
} as const;

const RESULT_STYLE = {
  completed: {
    Icon: CheckCircle2,
    card: 'border-status-success/20 bg-status-success/5',
    text: 'text-status-success/80',
  },
  stopped: {
    Icon: XCircle,
    card: 'border-status-info/20 bg-status-info/5',
    text: 'text-status-info/80',
  },
  failed: {
    Icon: AlertTriangle,
    card: 'border-status-interrupted/20 bg-status-interrupted/5',
    text: 'text-status-interrupted/80',
  },
};

export function AgentResultCard({
  status,
  cost: _cost,
  duration,
  startedAt,
  completedAt,
  copyThreadId,
  copyMessages,
  revealForSection,
  error,
  onContinue,
}: RunMetaProps & {
  status: 'completed' | 'failed' | 'stopped';
  cost: number;
  duration: number;
  /**
   * Turn (user message id) whose hover reveals this card. Failed and stopped
   * runs stay visible so their outcome is never hidden.
   */
  revealForSection?: string;
  error?: string;
  onContinue?: () => void;
}) {
  const { t } = useTranslation();
  const isSuccess = status === 'completed';
  const style = RESULT_STYLE[status];
  const Icon = style.Icon;
  const revealOnHover = isSuccess && !!revealForSection;
  const time = <CompletionTime completedAt={completedAt} />;
  const hasTime = !!parseTime(completedAt);

  return (
    <div
      {...(revealOnHover ? { 'data-turn-end-for': revealForSection } : {})}
      data-testid="agent-result-card"
      className={cn(
        'rounded-lg border px-3 py-1.5 text-xs flex flex-col gap-2',
        style.card,
        revealOnHover &&
          'opacity-0 transition-opacity duration-150 focus-within:opacity-100 data-[hovered]:opacity-100 [@media(hover:none)]:opacity-100',
      )}
    >
      <div className="flex flex-wrap items-center gap-3">
        <Icon className={cn('icon-base shrink-0', style.text)} />
        <span className={cn('font-medium', style.text)}>
          {hasTime ? (
            <Trans i18nKey={RESULT_LABEL_AT[status]} components={{ time }} />
          ) : (
            t(RESULT_LABEL[status])
          )}
        </span>
        <div className="text-muted-foreground ml-auto flex items-center gap-3">
          <RunMeta
            duration={duration}
            startedAt={startedAt}
            completedAt={completedAt}
            copyThreadId={copyThreadId}
            copyMessages={copyMessages}
          />
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

export function AgentInterruptedCard({
  onContinue,
  ...meta
}: RunMetaProps & { onContinue?: () => void }) {
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
      <div className="text-muted-foreground ml-auto flex items-center gap-3">
        <RunMeta showTime {...meta} />
        {onContinue && (
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
  );
}

export function AgentStoppedCard({
  onContinue,
  ...meta
}: RunMetaProps & { onContinue?: () => void }) {
  const { t } = useTranslation();

  return (
    <div className="border-status-info/20 bg-status-info/5 flex items-center gap-3 rounded-lg border px-3 py-2 text-xs">
      <XCircle className="icon-base text-status-info/80 shrink-0" />
      <div>
        <span className="text-status-info/80 font-medium">{t('thread.taskStopped')}</span>
        <p className="text-muted-foreground mt-0.5">{t('thread.manuallyStopped')}</p>
      </div>
      <div className="text-muted-foreground ml-auto flex items-center gap-3">
        <RunMeta showTime {...meta} />
        {onContinue && (
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
  );
}
