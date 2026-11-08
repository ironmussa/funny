import type { GitStatusInfo, Thread } from '@funny/shared';
import { Bot, Globe, NotebookPen } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { PRBadge } from '@/components/PRBadge';
import { ThreadTitle } from '@/components/thread/ThreadAttachmentsBadge';
import { ThreadPowerline } from '@/components/ThreadPowerline';
import { HighlightText } from '@/components/ui/highlight-text';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAgentTemplate } from '@/data/templates/hooks';
import { gitSyncStateConfig } from '@/lib/thread-utils';
import { canShowPowerline, isScratch } from '@/lib/thread-variant';
import { cn } from '@/lib/utils';
import { useThreadHasLiveBrowser } from '@/stores/browser-live-threads-store';

// ── Row 1: title + badges ────────────────────────────────────────────

function CreatedByIcon({ createdBy }: { createdBy?: string | null }) {
  const { t } = useTranslation();
  if (!createdBy || createdBy === 'user') return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Bot className="icon-xs text-muted-foreground shrink-0" />
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {t('thread.createdBy', { creator: createdBy })}
      </TooltipContent>
    </Tooltip>
  );
}

function RuntimeBadge({ thread }: { thread: Thread }) {
  if (thread.runtime === 'remote') {
    return (
      <span className="shrink-0 rounded bg-violet-500/15 px-1 py-0.5 text-[10px] leading-none font-medium text-violet-500">
        Remote
      </span>
    );
  }
  // Sandbox runtime badge (thread-sandboxes)
  if (thread.runtime === 'sandbox') {
    return (
      <span
        data-testid={`thread-item-sandbox-badge-${thread.id}`}
        className="bg-primary/15 text-primary shrink-0 rounded px-1 py-0.5 text-[10px] leading-none font-medium"
      >
        Sandbox
      </span>
    );
  }
  return null;
}

function AgentTemplateBadge({ thread }: { thread: Thread }) {
  const agentTemplate = useAgentTemplate(thread.agentTemplateId);
  if (!agentTemplate) return null;
  const color = agentTemplate.color;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[10px] leading-none font-medium"
          style={{
            backgroundColor: color ? `${color}22` : 'hsl(var(--muted))',
            color: color ?? 'hsl(var(--muted-foreground))',
          }}
          data-testid={`thread-template-badge-${thread.id}`}
        >
          {color && (
            <span
              className="inline-block size-1.5 rounded-full"
              style={{ backgroundColor: color }}
            />
          )}
          {agentTemplate.name}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {agentTemplate.description || agentTemplate.name}
      </TooltipContent>
    </Tooltip>
  );
}

export function ThreadItemTitleRow({
  thread,
  search,
  titleBadge,
  gitStatus,
}: {
  thread: Thread;
  search?: string;
  titleBadge?: ReactNode;
  gitStatus?: GitStatusInfo;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <ThreadTitle
        title={thread.title}
        search={search}
        density="compact"
        className="text-sm leading-tight"
        badgeTestId={`thread-item-attachments-${thread.id}`}
      />
      {titleBadge}
      {/* The thread's PR sits beside the title, not in the powerline row */}
      {gitStatus?.prNumber ? (
        <PRBadge
          prNumber={gitStatus.prNumber}
          prState={gitStatus.prState ?? 'OPEN'}
          prUrl={gitStatus.prUrl}
          size="compact"
          className="shrink-0"
          data-testid={`thread-pr-badge-${thread.id}`}
        />
      ) : null}
      {/* External creator icon */}
      <CreatedByIcon createdBy={thread.createdBy} />
      {/* Remote / sandbox runtime badge */}
      <RuntimeBadge thread={thread} />
      {/* Agent template badge */}
      <AgentTemplateBadge thread={thread} />
    </div>
  );
}

// ── Row 2: powerline + git status + snippet ──────────────────────────

function hasGitDiffStats(gitStatus?: GitStatusInfo): boolean {
  if (!gitStatus || gitStatus.state === 'clean') return false;
  return gitStatus.linesAdded > 0 || gitStatus.linesDeleted > 0 || gitStatus.dirtyFileCount > 0;
}

/**
 * Git state of the thread as one icon (dirty → file-diff + file count, unpushed →
 * blue commit, pushed → green PR arrow, merged → purple merge). The file/line
 * counts live in the tooltip instead of an always-visible chip, so rows that
 * share a working tree don't repeat the same numbers.
 */
function GitStateIcon({ threadId, gitStatus }: { threadId: string; gitStatus: GitStatusInfo }) {
  const { t } = useTranslation();
  // Clean trees show nothing; a PR badge already conveys pushed/merged.
  if (gitStatus.state === 'clean') return null;
  if (gitStatus.prNumber && (gitStatus.state === 'pushed' || gitStatus.state === 'merged')) {
    return null;
  }
  const cfg = gitSyncStateConfig[gitStatus.state];
  const Icon = cfg.icon;
  const hasStats = hasGitDiffStats(gitStatus);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'ml-auto flex h-3.5 shrink-0 items-center gap-0.5 text-xs leading-none',
            cfg.className,
          )}
          data-testid={`thread-git-state-${threadId}`}
        >
          <Icon className="icon-xs" />
          {gitStatus.state === 'dirty' && gitStatus.dirtyFileCount > 0 && (
            <span className="font-mono">{gitStatus.dirtyFileCount}</span>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        <div>{t(cfg.labelKey)}</div>
        {hasStats && (
          <div className="font-mono">
            {gitStatus.dirtyFileCount > 0 && (
              <span className="text-muted-foreground">
                {t('gitStats.dirtyFiles', { count: gitStatus.dirtyFileCount })}
                {' · '}
              </span>
            )}
            <span className="text-diff-added">+{gitStatus.linesAdded}</span>{' '}
            <span className="text-diff-removed">-{gitStatus.linesDeleted}</span>
          </div>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

type SnippetKind = 'highlight' | 'text' | 'launching' | 'backlog' | null;

/**
 * What the snippet slot shows. A newly-created thread is returned as `pending`
 * before the runner emits its first `running` status, so it counts as launching
 * and never briefly looks like an idle backlog item ("Ready to Launch").
 */
function resolveSnippetKind(
  thread: Thread,
  snippetText: string | undefined,
  highlight: boolean,
): SnippetKind {
  if (snippetText) return highlight ? 'highlight' : 'text';
  const isBusy = thread.status === 'running' || thread.status === 'setting_up';
  if (isBusy || thread.status === 'pending') return 'launching';
  if (!thread.stage || thread.stage === 'backlog') return 'backlog';
  return null;
}

const SNIPPET_CLASS = 'text-muted-foreground/50 min-w-0 flex-1 truncate text-xs';

function ThreadSnippet({
  kind,
  text,
  search,
}: {
  kind: SnippetKind;
  text: string;
  search?: string;
}) {
  const { t } = useTranslation();
  switch (kind) {
    case 'highlight':
      return <HighlightText text={text} query={search!} className={SNIPPET_CLASS} />;
    case 'text':
      return <span className={SNIPPET_CLASS}>{text}</span>;
    case 'launching':
      return (
        <span className={cn(SNIPPET_CLASS, 'italic')}>{t('thread.launching', 'Launching...')}</span>
      );
    case 'backlog':
      return (
        <span className={cn(SNIPPET_CLASS, 'italic')}>
          {t('thread.readyToLaunch', 'Ready to Launch')}
        </span>
      );
    default:
      return null;
  }
}

function ScratchBadge({ threadId }: { threadId: string }) {
  const { t } = useTranslation();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-testid={`thread-scratch-badge-${threadId}`}
          className="bg-muted/60 text-muted-foreground flex shrink-0 items-center rounded p-1 leading-none"
        >
          <NotebookPen className="icon-xs" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {t('thread.scratchTooltip', {
          defaultValue: 'Scratch thread — no project, no git',
        })}
      </TooltipContent>
    </Tooltip>
  );
}

function LiveBrowserIcon({ threadId }: { threadId: string }) {
  const { t } = useTranslation();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-testid={`thread-browser-open-${threadId}`}
          className="text-muted-foreground flex shrink-0 items-center leading-none"
        >
          <Globe className="icon-xs" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {t('thread.browserOpenTooltip', { defaultValue: 'Browser open' })}
      </TooltipContent>
    </Tooltip>
  );
}

interface ThreadItemMetaRowProps {
  thread: Thread;
  subtitle?: string;
  projectColor?: string;
  projectPath: string;
  gitStatus?: GitStatusInfo;
  metadataBadge?: ReactNode;
  contentSnippet?: string;
  search?: string;
}

/**
 * Scratch threads have no project / branch / worktree — never show the
 * powerline even if older DB rows still carry a stale `branch` value.
 * Instead they get a scratch-pad icon as the row's identifier.
 */
function hasPowerlineInfo(thread: Thread, subtitle?: string): boolean {
  if (!canShowPowerline(thread)) return false;
  return !!subtitle || !!thread.baseBranch || !!thread.branch;
}

/** Whether the row shows anything besides the snippet. */
function hasMetaContent(
  showPowerline: boolean,
  scratch: boolean,
  liveBrowser: boolean,
  { gitStatus, metadataBadge }: ThreadItemMetaRowProps,
): boolean {
  return (
    showPowerline ||
    scratch ||
    liveBrowser ||
    !!metadataBadge ||
    (!!gitStatus && gitStatus.state !== 'clean')
  );
}

function resolveMetaRow(props: ThreadItemMetaRowProps, liveBrowser: boolean) {
  const { thread, subtitle, contentSnippet, search } = props;
  const snippetText = contentSnippet ?? thread.lastAssistantMessage;
  const snippetKind = resolveSnippetKind(thread, snippetText, !!(contentSnippet && search));
  const scratch = isScratch(thread);
  const showPowerline = hasPowerlineInfo(thread, subtitle);
  return {
    snippetText,
    snippetKind,
    scratch,
    showPowerline,
    visible: snippetKind !== null || hasMetaContent(showPowerline, scratch, liveBrowser, props),
  };
}

/** Row 2: Powerline (project → branch) + Git status + Snippet. */
export function ThreadItemMetaRow(props: ThreadItemMetaRowProps) {
  const { thread, subtitle, projectColor, projectPath, gitStatus, metadataBadge, search } = props;
  const liveBrowser = useThreadHasLiveBrowser(thread.id);
  const row = resolveMetaRow(props, liveBrowser);
  if (!row.visible) return null;

  return (
    <div className="flex min-h-[22px] min-w-0 flex-col items-stretch gap-1.5 sm:flex-row sm:items-center">
      {row.showPowerline && (
        <ThreadPowerline
          thread={thread}
          projectName={subtitle}
          projectColor={projectColor}
          projectTooltip={projectPath}
          gitStatus={gitStatus}
          showDiffStats={false}
          showPRBadge={false}
          diffStatsSize="xs"
          data-testid={`thread-powerline-${thread.id}`}
        />
      )}
      {liveBrowser && <LiveBrowserIcon threadId={thread.id} />}
      {row.scratch && <ScratchBadge threadId={thread.id} />}
      {metadataBadge}
      <ThreadSnippet kind={row.snippetKind} text={row.snippetText ?? ''} search={search} />
      {gitStatus && <GitStateIcon threadId={thread.id} gitStatus={gitStatus} />}
    </div>
  );
}
