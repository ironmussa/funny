/**
 * PipelineEventCard — Compact inline card for pipeline events.
 * Displayed inline in the thread chat timeline alongside git events.
 */

import type { ThreadEvent } from '@funny/shared';
import {
  Shield,
  Eye,
  Wrench,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ArrowRight,
  ExternalLink,
  ChevronRight,
  Repeat,
  Check,
  X,
  Minus,
} from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { ScrollArea } from '@/components/ui/scroll-area';
import { createAnsiConverter } from '@/lib/ansi-to-html';
import { timeAgo } from '@/lib/thread-utils';
import { buildPath } from '@/lib/url';
import { cn } from '@/lib/utils';
import { useThreadProjectId } from '@/stores/thread-context';

/** Navigate to a child thread by updating the URL (so the back button works). */
function useNavigateToThread() {
  const navigate = useNavigate();
  const projectId = useThreadProjectId();
  return useCallback(
    (threadId: string) => {
      if (projectId) {
        navigate(buildPath(`/projects/${projectId}/threads/${threadId}`));
      }
    },
    [navigate, projectId],
  );
}

function parseEventData(data: string | Record<string, unknown>): Record<string, any> {
  if (typeof data === 'string') {
    try {
      return JSON.parse(data);
    } catch {
      return {};
    }
  }
  return data as Record<string, any>;
}

interface PipelineEventConfig {
  icon: typeof Shield;
  label: string;
  color: string; // tailwind text color class
}

const eventConfig: Record<string, PipelineEventConfig> = {
  'pipeline:started': {
    icon: Shield,
    label: 'Pipeline started',
    color: 'text-muted-foreground',
  },
  'pipeline:reviewer_started': {
    icon: Eye,
    label: 'Reviewing',
    color: 'text-muted-foreground',
  },
  'pipeline:review_verdict': {
    icon: Eye,
    label: 'Review verdict',
    color: 'text-muted-foreground',
  },
  'pipeline:corrector_started': {
    icon: Wrench,
    label: 'Fixing',
    color: 'text-muted-foreground',
  },
  'pipeline:fix_applied': {
    icon: CheckCircle2,
    label: 'Fix applied',
    color: 'text-muted-foreground',
  },
  'pipeline:completed': {
    icon: CheckCircle2,
    label: 'Pipeline completed',
    color: 'text-muted-foreground',
  },
  'pipeline:precommit_hooks': {
    icon: Shield,
    label: 'Pre-commit hooks',
    color: 'text-muted-foreground',
  },
  'pipeline:precommit_fixer_started': {
    icon: Wrench,
    label: 'Pre-commit fixing',
    color: 'text-muted-foreground',
  },
  'pipeline:precommit_fixing': {
    icon: Wrench,
    label: 'Pre-commit fixing',
    color: 'text-muted-foreground',
  },
  'pipeline:precommit_fixed': {
    icon: CheckCircle2,
    label: 'Pre-commit fixed',
    color: 'text-muted-foreground',
  },
  'pipeline:precommit_failed': {
    icon: XCircle,
    label: 'Pre-commit fix failed',
    color: 'text-muted-foreground',
  },
};

/** Sub-item status icon for hook results */
function HookStatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'completed':
      return <Check className="icon-xs text-muted-foreground" />;
    case 'failed':
      return <X className="icon-xs text-muted-foreground" />;
    default:
      return <Minus className="icon-xs text-muted-foreground/30" />;
  }
}

export const PipelineEventCard = memo(function PipelineEventCard({
  event,
}: {
  event: ThreadEvent;
}) {
  const { t } = useTranslation();
  const navigateToThread = useNavigateToThread();
  const config = eventConfig[event.type];
  if (!config) return null;

  const Icon = config.icon;
  const metadata = parseEventData(event.data);

  // pipeline:precommit_hooks gets a special expanded card
  if (event.type === 'pipeline:precommit_hooks') {
    return <PrecommitHooksCard event={event} config={config} metadata={metadata} />;
  }

  // Customize display based on event type
  let detail: React.ReactNode = null;
  let statusIcon: React.ReactNode = null;

  switch (event.type) {
    case 'pipeline:started': {
      const sha = metadata.commitSha?.slice(0, 7);
      detail = sha ? <span className="font-mono text-muted-foreground">{sha}</span> : null;
      break;
    }

    case 'pipeline:reviewer_started': {
      const iter = metadata.iteration;
      const max = metadata.maxIterations;
      detail = (
        <span className="inline-flex items-center gap-0.5 text-muted-foreground">
          <Repeat className="icon-2xs" />
          {iter}/{max}
        </span>
      );
      if (metadata.reviewerThreadId) {
        detail = (
          <>
            {detail}
            <button
              data-testid={`pipeline-link-reviewer-${metadata.reviewerThreadId}`}
              className="ml-1 inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground hover:underline"
              onClick={() => navigateToThread(metadata.reviewerThreadId)}
            >
              <ExternalLink className="icon-2xs" />
              <span>view</span>
            </button>
          </>
        );
      }
      break;
    }

    case 'pipeline:review_verdict': {
      const isPassing = metadata.verdict === 'pass';
      statusIcon = isPassing ? (
        <CheckCircle2 className="icon-xs text-muted-foreground" />
      ) : (
        <AlertTriangle className="icon-xs text-muted-foreground" />
      );
      detail = (
        <span className="font-medium text-muted-foreground">
          {isPassing ? 'PASS' : 'FAIL'}
          {!isPassing && metadata.findingsCount > 0 && (
            <span className="ml-1 font-normal text-muted-foreground/70">
              ({metadata.findingsCount} finding{metadata.findingsCount !== 1 ? 's' : ''})
            </span>
          )}
        </span>
      );
      break;
    }

    case 'pipeline:corrector_started': {
      detail = (
        <span className="inline-flex items-center gap-0.5 text-muted-foreground">
          <Repeat className="icon-2xs" />
          {metadata.iteration}
        </span>
      );
      if (metadata.correctorThreadId) {
        detail = (
          <>
            {detail}
            <button
              data-testid={`pipeline-link-corrector-${metadata.correctorThreadId}`}
              className="ml-1 inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground hover:underline"
              onClick={() => navigateToThread(metadata.correctorThreadId)}
            >
              <ExternalLink className="icon-2xs" />
              <span>view</span>
            </button>
          </>
        );
      }
      break;
    }

    case 'pipeline:fix_applied': {
      detail = (
        <span className="inline-flex items-center gap-0.5 text-muted-foreground">
          <Repeat className="icon-2xs" />
          {metadata.iteration}
          <ArrowRight className="icon-2xs mx-1 inline" />
          re-reviewing
        </span>
      );
      break;
    }

    case 'pipeline:completed': {
      const status = metadata.status;
      const isPassed = status === 'completed';
      statusIcon = isPassed ? (
        <CheckCircle2 className="icon-xs text-muted-foreground" />
      ) : (
        <XCircle className="icon-xs text-muted-foreground" />
      );
      detail = (
        <span className="font-medium text-muted-foreground">
          {isPassed ? 'passed' : status === 'failed' ? 'failed' : 'skipped'}
          {metadata.totalIterations > 0 && (
            <span className="ml-1 font-normal text-muted-foreground/70">
              (<Repeat className="icon-2xs mr-0.5 inline" />
              {metadata.totalIterations})
            </span>
          )}
        </span>
      );
      break;
    }

    case 'pipeline:precommit_fixer_started': {
      detail = (
        <span className="text-muted-foreground">
          {metadata.hookLabel}
          <span className="ml-1">
            attempt {metadata.attempt}/{metadata.maxIterations}
          </span>
        </span>
      );
      if (metadata.fixerThreadId) {
        detail = (
          <>
            {detail}
            <button
              data-testid={`pipeline-link-fixer-${metadata.fixerThreadId}`}
              className="ml-1 inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground hover:underline"
              onClick={() => navigateToThread(metadata.fixerThreadId)}
            >
              <ExternalLink className="icon-2xs" />
              <span>view</span>
            </button>
          </>
        );
      }
      break;
    }

    case 'pipeline:precommit_fixing': {
      detail = <span className="text-muted-foreground">{metadata.hookLabel}</span>;
      break;
    }

    case 'pipeline:precommit_fixed': {
      detail = (
        <span className="text-muted-foreground">
          {metadata.hookLabel}
          <span className="ml-1">
            ({metadata.attempts} attempt{metadata.attempts !== 1 ? 's' : ''})
          </span>
        </span>
      );
      break;
    }

    case 'pipeline:precommit_failed': {
      detail = (
        <span className="text-muted-foreground">
          {metadata.hookLabel}
          <span className="ml-1">(max {metadata.maxIterations} attempts)</span>
        </span>
      );
      break;
    }
  }

  return (
    <div
      data-testid={`pipeline-event-${event.type}`}
      className="flex w-full items-center gap-2 overflow-hidden rounded-md px-3 py-1.5 text-xs transition-colors hover:bg-accent/30"
    >
      {statusIcon || <Icon className={cn('icon-xs shrink-0', config.color)} />}
      <span className={cn('shrink-0 font-mono font-medium', config.color)}>{config.label}</span>
      {detail}
      {event.createdAt && (
        <span className="ml-auto shrink-0 text-muted-foreground">
          {timeAgo(event.createdAt, t)}
        </span>
      )}
    </div>
  );
});

/**
 * Special expanded card for pre-commit hooks results.
 * Shows each hook with its pass/fail status and error output.
 * Uses AnsiToHtml to render ANSI color codes in error output,
 * matching the style used in BashCard / ToolCallCard.
 */
function PrecommitHooksCard({
  event,
  config,
  metadata,
}: {
  event: ThreadEvent;
  config: PipelineEventConfig;
  metadata: Record<string, any>;
}) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(metadata.status === 'failed');
  const Icon = config.icon;
  const hooks: Array<{ label: string; status: string; error?: string }> = metadata.hooks ?? [];
  const hasFailed = metadata.status === 'failed';

  // Security M6: `createAnsiConverter` enforces escapeXML regardless of caller.
  const ansiConverter = useMemo(
    () => createAnsiConverter({ fg: '#a1a1aa', bg: 'transparent', newline: false }),
    [],
  );

  // Pre-convert all hook errors from ANSI to HTML
  const hookErrorsHtml = useMemo(() => {
    const map = new Map<number, string>();
    hooks.forEach((hook, i) => {
      if (hook.error) {
        map.set(i, ansiConverter.toHtml(hook.error));
      }
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metadata.hooks, ansiConverter]);

  return (
    <div
      data-testid="pipeline-event-pipeline:precommit_hooks"
      className="w-full overflow-hidden rounded-md text-xs transition-colors"
    >
      {/* Header row — clickable to expand/collapse */}
      <button
        data-testid="pipeline-precommit-hooks-toggle"
        className={cn(
          'flex w-full items-center gap-2 px-3 py-1.5 transition-colors hover:bg-accent/30',
          isOpen && 'bg-accent/20',
        )}
        onClick={() => setIsOpen(!isOpen)}
      >
        <ChevronRight
          className={cn(
            'icon-xs shrink-0 text-muted-foreground transition-transform',
            isOpen && 'rotate-90',
          )}
        />
        <Icon className="icon-xs shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-mono font-medium text-muted-foreground">
          Pre-commit hooks
        </span>
        <span className="font-medium text-muted-foreground">{hasFailed ? 'FAILED' : 'PASSED'}</span>
        <span className="text-muted-foreground">
          ({hooks.length} hook{hooks.length !== 1 ? 's' : ''})
        </span>
        {event.createdAt && (
          <span className="ml-auto shrink-0 text-muted-foreground">
            {timeAgo(event.createdAt, t)}
          </span>
        )}
      </button>

      {/* Expanded content — sub-items list */}
      {isOpen && hooks.length > 0 && (
        <div className="space-y-1 px-3 pb-2 pl-10">
          {hooks.map((hook, i) => {
            const errorHtml = hookErrorsHtml.get(i);
            return (
              <div key={i}>
                <div
                  className={cn(
                    'flex items-center gap-1.5 text-[11px]',
                    hook.status === 'completed' && 'text-muted-foreground',
                    hook.status === 'failed' && 'text-muted-foreground',
                    hook.status === 'pending' && 'text-muted-foreground/40',
                  )}
                >
                  <div className="flex-shrink-0">
                    <HookStatusIcon status={hook.status} />
                  </div>
                  <span className="truncate font-mono">{hook.label}</span>
                </div>
                {errorHtml && (
                  <ScrollArea className="ml-4.5 mt-0.5 max-h-60 rounded border border-border/40 bg-background/80">
                    <pre
                      className="whitespace-pre-wrap break-words px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground"
                      dangerouslySetInnerHTML={{ __html: errorHtml }}
                    />
                  </ScrollArea>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
