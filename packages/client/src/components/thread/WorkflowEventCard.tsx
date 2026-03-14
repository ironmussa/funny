/**
 * WorkflowEventCard — Compact inline card for workflow pipeline events.
 * Displays individual steps (hooks, review, fix) within a WorkflowEventGroup.
 */

import type { ThreadEvent } from '@funny/shared';
import AnsiToHtml from 'ansi-to-html';
import {
  Shield,
  Eye,
  Wrench,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ExternalLink,
  Repeat,
  GitCommit,
  Upload,
  GitMerge,
  GitPullRequest,
  Plus,
  Minus,
  ChevronRight,
  Loader2,
} from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { Badge } from '@/components/ui/badge';
import { timeAgo } from '@/lib/thread-utils';
import { buildPath } from '@/lib/url';
import { cn } from '@/lib/utils';
import { useThreadStore } from '@/stores/thread-store';

/** Navigate to a child thread by updating the URL (so the back button works). */
function useNavigateToThread() {
  const navigate = useNavigate();
  const projectId = useThreadStore((s) => s.activeThread?.projectId);
  return useCallback(
    (threadId: string) => {
      if (projectId) {
        navigate(buildPath(`/projects/${projectId}/threads/${threadId}`));
      }
    },
    [navigate, projectId],
  );
}

const ansiConverter = new AnsiToHtml({
  fg: '#d4d4d4',
  bg: 'transparent',
  escapeXML: true,
});

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

/** Config for workflow-specific event types */
const workflowEventConfig: Record<string, { icon: typeof Shield; label: string }> = {
  'workflow:started': { icon: Shield, label: 'Workflow started' },
  'workflow:completed': { icon: CheckCircle2, label: 'Workflow completed' },
  'workflow:hooks': { icon: Shield, label: 'Pre-commit hooks' },
  'workflow:review': { icon: Eye, label: 'Code review' },
  'workflow:fix': { icon: Wrench, label: 'Fix applied' },
  'workflow:precommit_fix': { icon: Wrench, label: 'Pre-commit fix' },
};

/** Config for git event types that appear inside workflows */
const gitEventConfig: Record<string, { icon: typeof GitCommit; label: string }> = {
  'git:commit': { icon: GitCommit, label: 'Committed' },
  'git:push': { icon: Upload, label: 'Pushed' },
  'git:merge': { icon: GitMerge, label: 'Merged' },
  'git:pr_created': { icon: GitPullRequest, label: 'PR Created' },
  'git:stage': { icon: Plus, label: 'Staged' },
  'git:unstage': { icon: Minus, label: 'Unstaged' },
};

/** Dedicated sub-component for hooks events — supports expandable ANSI error output */
const HooksEventCard = memo(function HooksEventCard({
  event,
  metadata,
}: {
  event: ThreadEvent;
  metadata: Record<string, any>;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const hasFailed = metadata.status === 'failed';
  const hooks: Array<{ label: string; status: string; error?: string }> = metadata.hooks ?? [];

  // Collect error output from failed hooks
  const errorOutput = useMemo(() => {
    const errors = hooks
      .filter((h) => h.status === 'failed' && h.error)
      .map((h) => h.error!)
      .join('\n');
    if (!errors) return null;
    return ansiConverter.toHtml(errors);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metadata.hooks]);

  const hasError = hasFailed && errorOutput;

  return (
    <div data-testid={`workflow-event-${event.type}`} className="w-full">
      <button
        type="button"
        data-testid="workflow-hooks-toggle"
        className={cn(
          'flex w-full items-center gap-2 overflow-hidden rounded-md px-3 py-1.5 text-xs transition-colors',
          hasError && 'cursor-pointer hover:bg-accent/30',
        )}
        onClick={() => hasError && setExpanded(!expanded)}
        disabled={!hasError}
      >
        {hasFailed ? (
          <XCircle className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <CheckCircle2 className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
        <span className="shrink-0 font-mono font-medium text-muted-foreground">
          Pre-commit hooks
        </span>
        <Badge
          data-testid={`workflow-hooks-verdict-${hasFailed ? 'fail' : 'pass'}`}
          variant={hasFailed ? 'destructive' : 'default'}
          className="h-4 px-1.5 py-0 text-[10px] leading-none"
        >
          {hasFailed ? 'FAILED' : 'PASSED'}
        </Badge>
        <span className="text-muted-foreground/70">
          ({hooks.length} hook{hooks.length !== 1 ? 's' : ''})
        </span>
        {hasError && (
          <ChevronRight
            className={cn(
              'ml-auto h-3 w-3 shrink-0 text-muted-foreground transition-transform',
              expanded && 'rotate-90',
            )}
          />
        )}
        {!hasError && event.createdAt && (
          <span className="ml-auto shrink-0 text-muted-foreground">
            {timeAgo(event.createdAt, t)}
          </span>
        )}
      </button>
      {expanded && errorOutput && (
        <div className="mx-3 mb-2 mt-1 max-h-60 overflow-auto rounded border border-border/50 bg-black/80 p-2">
          <pre
            className="whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-[#d4d4d4]"
            dangerouslySetInnerHTML={{ __html: errorOutput }}
          />
        </div>
      )}
    </div>
  );
});

export const WorkflowEventCard = memo(function WorkflowEventCard({
  event,
}: {
  event: ThreadEvent;
}) {
  const { t } = useTranslation();
  const navigateToThread = useNavigateToThread();
  const metadata = parseEventData(event.data);

  // Try workflow config first, then git config
  const wfConfig = workflowEventConfig[event.type];
  const gConfig = gitEventConfig[event.type];
  const config = wfConfig || gConfig;
  if (!config) return null;

  const Icon = config.icon;
  let detail: React.ReactNode = null;
  let statusIcon: React.ReactNode = null;

  switch (event.type) {
    case 'workflow:started': {
      detail = <span className="text-muted-foreground">{metadata.title}</span>;
      break;
    }

    case 'workflow:completed': {
      const isPassed = metadata.status === 'completed';
      statusIcon = isPassed ? (
        <CheckCircle2 className="h-3 w-3 text-muted-foreground" />
      ) : (
        <XCircle className="h-3 w-3 text-destructive" />
      );
      detail = (
        <>
          <span
            className={cn('font-medium', isPassed ? 'text-muted-foreground' : 'text-destructive')}
          >
            {isPassed ? 'completed' : 'failed'}
          </span>
          {!isPassed && metadata.error && (
            <span className="min-w-0 truncate font-mono text-destructive/80">
              — {metadata.error}
            </span>
          )}
        </>
      );
      break;
    }

    case 'workflow:hooks': {
      return <HooksEventCard event={event} metadata={metadata} />;
    }

    case 'workflow:review': {
      const isPassing = metadata.verdict === 'pass';
      statusIcon = isPassing ? (
        <CheckCircle2 className="h-3 w-3 text-muted-foreground" />
      ) : (
        <AlertTriangle className="h-3 w-3 text-muted-foreground" />
      );
      detail = (
        <>
          <Badge
            data-testid={`workflow-review-verdict-${isPassing ? 'pass' : 'fail'}`}
            variant={isPassing ? 'default' : 'destructive'}
            className="h-4 px-1.5 py-0 text-[10px] leading-none"
          >
            {isPassing ? 'PASS' : 'FAIL'}
          </Badge>
          {!isPassing && metadata.findingsCount > 0 && (
            <span className="font-normal text-muted-foreground/70">
              ({metadata.findingsCount} finding{metadata.findingsCount !== 1 ? 's' : ''})
            </span>
          )}
          <span className="inline-flex items-center gap-0.5 text-muted-foreground">
            <Repeat className="h-2.5 w-2.5" />
            {metadata.iteration}
          </span>
          {metadata.reviewerThreadId && (
            <button
              data-testid={`workflow-link-reviewer-${metadata.reviewerThreadId}`}
              className="ml-1 inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground hover:underline"
              onClick={() => navigateToThread(metadata.reviewerThreadId)}
            >
              <ExternalLink className="h-2.5 w-2.5" />
              <span>view</span>
            </button>
          )}
        </>
      );
      break;
    }

    case 'workflow:fix': {
      detail = (
        <>
          <span className="inline-flex items-center gap-0.5 text-muted-foreground">
            <Repeat className="h-2.5 w-2.5" />
            {metadata.iteration}
            {metadata.hasChanges === false && (
              <span className="ml-1 text-muted-foreground/70">(no changes)</span>
            )}
          </span>
          {metadata.correctorThreadId && (
            <button
              data-testid={`workflow-link-corrector-${metadata.correctorThreadId}`}
              className="ml-1 inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground hover:underline"
              onClick={() => navigateToThread(metadata.correctorThreadId)}
            >
              <ExternalLink className="h-2.5 w-2.5" />
              <span>view</span>
            </button>
          )}
        </>
      );
      break;
    }

    case 'workflow:precommit_fix': {
      const isRunning = metadata.status === 'running';
      statusIcon = isRunning ? (
        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
      ) : (
        <CheckCircle2 className="h-3 w-3 text-muted-foreground" />
      );
      detail = (
        <>
          <span className="text-muted-foreground">
            {metadata.hookLabel}
            <span className="ml-1 text-muted-foreground/70">(attempt {metadata.attempt})</span>
          </span>
          {metadata.fixerThreadId && (
            <button
              data-testid={`workflow-link-fixer-${metadata.fixerThreadId}`}
              className="ml-1 inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground hover:underline"
              onClick={() => navigateToThread(metadata.fixerThreadId)}
            >
              <ExternalLink className="h-2.5 w-2.5" />
              <span>view</span>
            </button>
          )}
        </>
      );
      break;
    }

    // Git events rendered inside the workflow group
    case 'git:commit': {
      detail = metadata.message ? (
        <span className="min-w-0 truncate font-mono text-muted-foreground">{metadata.message}</span>
      ) : null;
      break;
    }

    case 'git:push':
    case 'git:merge':
      break;

    case 'git:pr_created': {
      detail =
        metadata.title && metadata.url ? (
          <a
            href={metadata.url}
            target="_blank"
            rel="noopener noreferrer"
            className="min-w-0 truncate font-mono text-muted-foreground hover:text-primary hover:underline"
          >
            {metadata.title}
          </a>
        ) : null;
      break;
    }

    case 'git:stage':
    case 'git:unstage': {
      const paths = metadata.paths;
      detail =
        paths && Array.isArray(paths) ? (
          <span className="min-w-0 truncate font-mono text-muted-foreground">
            {paths.length === 1 ? paths[0] : `${paths.length} files`}
          </span>
        ) : null;
      break;
    }
  }

  return (
    <div
      data-testid={`workflow-event-${event.type}`}
      className="flex w-full items-center gap-2 overflow-hidden rounded-md px-3 py-1.5 text-xs transition-colors hover:bg-accent/30"
    >
      {statusIcon || <Icon className={cn('h-3 w-3 shrink-0 text-muted-foreground')} />}
      <span className="shrink-0 font-mono font-medium text-muted-foreground">{config.label}</span>
      {detail}
      {event.createdAt && (
        <span className="ml-auto shrink-0 text-muted-foreground">
          {timeAgo(event.createdAt, t)}
        </span>
      )}
    </div>
  );
});
