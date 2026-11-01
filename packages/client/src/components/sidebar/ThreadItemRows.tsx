import type { GitStatusInfo, Thread } from '@funny/shared';
import { Bot, NotebookPen } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { ThreadTitle } from '@/components/thread/ThreadAttachmentsBadge';
import { ThreadPowerline } from '@/components/ThreadPowerline';
import { HighlightText } from '@/components/ui/highlight-text';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { canShowPowerline, isScratch } from '@/lib/thread-variant';
import { cn } from '@/lib/utils';
import { useAgentTemplateStore } from '@/stores/agent-template-store';

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
  const agentTemplate = useAgentTemplateStore((s) =>
    thread.agentTemplateId ? s.templates.find((t) => t.id === thread.agentTemplateId) : undefined,
  );
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
}: {
  thread: Thread;
  search?: string;
  titleBadge?: ReactNode;
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

function resolveMetaRow({
  thread,
  subtitle,
  gitStatus,
  metadataBadge,
  contentSnippet,
  search,
}: ThreadItemMetaRowProps) {
  const snippetText = contentSnippet ?? thread.lastAssistantMessage;
  const snippetKind = resolveSnippetKind(thread, snippetText, !!(contentSnippet && search));
  const scratch = isScratch(thread);
  const showPowerline = hasPowerlineInfo(thread, subtitle) || !!gitStatus?.prNumber;
  const hasMetadata = showPowerline || hasGitDiffStats(gitStatus) || scratch || !!metadataBadge;
  return {
    snippetText,
    snippetKind,
    scratch,
    showPowerline,
    visible: hasMetadata || snippetKind !== null,
  };
}

/** Row 2: Powerline (project → branch) + Git status + Snippet. */
export function ThreadItemMetaRow(props: ThreadItemMetaRowProps) {
  const { thread, subtitle, projectColor, projectPath, gitStatus, metadataBadge, search } = props;
  const row = resolveMetaRow(props);
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
          diffStatsSize="xs"
          prBadgeSize="compact"
          prBadgeTestId={`thread-pr-badge-${thread.id}`}
          data-testid={`thread-powerline-${thread.id}`}
        />
      )}
      {row.scratch && <ScratchBadge threadId={thread.id} />}
      {metadataBadge}
      <ThreadSnippet kind={row.snippetKind} text={row.snippetText ?? ''} search={search} />
    </div>
  );
}
