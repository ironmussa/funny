import {
  Cherry,
  CloudUpload,
  Copy,
  ExternalLink,
  GitBranch,
  GitBranchPlus,
  GitMerge,
  Hash,
  History,
  MoreVertical,
  Plus,
  RotateCcw,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { CreateBranchDialog } from '@/components/commit-graph/CreateBranchDialog';
import { CommitActionConfirm } from '@/components/CommitActionConfirm';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useCommitActions } from '@/hooks/use-commit-actions';
import type { GitRebaseReflogEventDTO } from '@/lib/api/git';
import { listRowActionClassName } from '@/lib/list-row-styles';
import { rebaseEventScopeLabel } from '@/lib/rebase-events';
import { cn } from '@/lib/utils';

interface Props {
  hash: string;
  shortHash: string;
  /** Resolved GitHub commit URL, or null when the repo has no GitHub remote. */
  githubUrl: string | null;
  effectiveThreadId?: string;
  projectModeId: string | null;
  /**
   * Local-only branches whose tip is THIS commit (folded `local` refs with no
   * synced remote) — each gets a "Push … to origin" entry. Empty when the commit
   * is not the tip of an unpushed local branch, in which case no push item shows.
   */
  localBranches?: string[];
  /** Local branches at this commit that can be used as merge/rebase targets. */
  targetBranches?: string[];
  /** Branches at this commit a new thread can start from (see `threadBaseBranchesAt`). */
  threadBranches?: string[];
  /** Opens the new-thread composer on a branch. No "New thread" items without it. */
  onCreateThreadFromBranch?: (branch: string) => void;
  rebaseEvents?: GitRebaseReflogEventDTO[];
  onSelectRebaseEvent?: (event: GitRebaseReflogEventDTO) => void;
  /** Reload the graph log after a mutating action. */
  onAfterAction: () => void;
  /**
   * Notified when the dropdown opens/closes — lets a parent swap cell (e.g.
   * {@link HoverTimeMenu}) keep the trigger pinned while the menu is open.
   */
  onOpenChange?: (open: boolean) => void;
  /**
   * Overrides the trigger button classes. Defaults to the standalone
   * hover-reveal styling; pass neutral classes when the parent (a swap cell)
   * already owns the show-on-hover behavior.
   */
  triggerClassName?: string;
}

/** Stable empty default for {@link Props.localBranches} — a literal `[]` default
 * would be a fresh reference each render and churn referential equality. */
const NO_BRANCHES: string[] = [];
const NO_TARGET_BRANCHES: string[] = [];
const NO_THREAD_BRANCHES: string[] = [];
const NO_REBASE_EVENTS: GitRebaseReflogEventDTO[] = [];

/**
 * Three-dots (kebab) menu for a commit row in the graph — the app-standard
 * affordance (mirrors the sidebar/kanban row menus) for per-row actions: copy
 * SHA, open on GitHub, and checkout / revert / hard-reset. All mutating logic is
 * delegated to the shared {@link useCommitActions} hook so it stays in sync with
 * the CommitDetailDialog instead of re-implementing it.
 *
 * Hidden until the row is hovered (or the menu is open), like the other row
 * kebabs; the parent row supplies the `group` class.
 */
export function CommitActionsMenu({
  hash,
  shortHash,
  githubUrl,
  effectiveThreadId,
  projectModeId,
  localBranches = NO_BRANCHES,
  targetBranches = NO_TARGET_BRANCHES,
  threadBranches = NO_THREAD_BRANCHES,
  onCreateThreadFromBranch,
  rebaseEvents = NO_REBASE_EVENTS,
  onSelectRebaseEvent,
  onAfterAction,
  onOpenChange,
  triggerClassName,
}: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };
  const [createBranchOpen, setCreateBranchOpen] = useState(false);
  const { pending, request, cancel, confirm, hasGitContext, pushBranch, createBranch } =
    useCommitActions({
      effectiveThreadId,
      projectModeId,
      onAfterAction,
    });

  const copy = (value: string) =>
    void navigator.clipboard.writeText(value).then(
      () =>
        toast.success(
          t('history.hashCopied', {
            hash: shortHash,
            defaultValue: `Copied ${shortHash}`,
          }),
        ),
      () => toast.error(t('history.hashCopyFailed', 'Failed to copy hash')),
    );

  return (
    <>
      <DropdownMenu open={open} onOpenChange={handleOpenChange}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="muted"
            size="icon-xs"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
            // oxlint-disable shadcn/require-static-classes -- triggerClassName is a caller-provided prop; listRowActionClassName is a static constant
            className={cn(
              triggerClassName
                ? cn('shrink-0', triggerClassName)
                : cn(listRowActionClassName, 'ml-auto', open && 'opacity-100'),
            )}
            // oxlint-enable shadcn/require-static-classes
            data-testid={`graph-commit-more-${shortHash}`}
          >
            <MoreVertical className="icon-sm" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          side="bottom"
          className="w-64"
          onClick={(e) => e.stopPropagation()}
        >
          <DropdownMenuItem
            onClick={() => copy(hash)}
            data-testid={`graph-commit-menu-copy-sha-${shortHash}`}
          >
            <Hash className="icon-sm" />
            {t('graph.copySha', 'Copy commit SHA')}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => copy(shortHash)}
            data-testid={`graph-commit-menu-copy-short-${shortHash}`}
          >
            <Copy className="icon-sm" />
            {t('graph.copyShortSha', 'Copy short SHA')}
          </DropdownMenuItem>
          {githubUrl && (
            <DropdownMenuItem
              onClick={() => window.open(githubUrl, '_blank', 'noopener,noreferrer')}
              data-testid={`graph-commit-menu-github-${shortHash}`}
            >
              <ExternalLink className="icon-sm" />
              {t('history.viewOnGithub', 'View on GitHub')}
            </DropdownMenuItem>
          )}
          {onSelectRebaseEvent && (
            <RebaseDetailsItem
              events={rebaseEvents}
              shortHash={shortHash}
              onSelect={(event) => {
                onSelectRebaseEvent(event);
                handleOpenChange(false);
              }}
            />
          )}
          {hasGitContext && (
            <>
              <PushBranchItems branches={localBranches} onPush={(b) => void pushBranch(b)} />
              <DropdownMenuSeparator />
              {onCreateThreadFromBranch && (
                <NewThreadItems branches={threadBranches} onCreate={onCreateThreadFromBranch} />
              )}
              <DropdownMenuItem
                onClick={() => setCreateBranchOpen(true)}
                data-testid={`graph-commit-menu-create-branch-${shortHash}`}
              >
                <GitBranchPlus className="icon-sm" />
                {t('graph.createBranchHere', 'Create branch from here')}
              </DropdownMenuItem>
              {targetBranches.map((branch) => (
                <DropdownMenuItem
                  key={`merge-current-into:${branch}`}
                  onClick={() => request('merge-current-into', branch)}
                  data-testid={`graph-commit-menu-merge-current-into-${branch}`}
                >
                  <GitMerge className="icon-sm" />
                  {t('graph.mergeCurrentIntoBranch', {
                    branch,
                    defaultValue: `Merge current branch into ${branch}`,
                  })}
                </DropdownMenuItem>
              ))}
              {targetBranches.map((branch) => (
                <DropdownMenuItem
                  key={`rebase-current-onto:${branch}`}
                  onClick={() => request('rebase-current-onto', branch)}
                  data-testid={`graph-commit-menu-rebase-current-onto-${branch}`}
                >
                  <GitBranch className="icon-sm" />
                  {t('graph.rebaseCurrentOntoBranch', {
                    branch,
                    defaultValue: `Rebase current branch onto ${branch}`,
                  })}
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem
                onClick={() => request('cherry-pick', hash)}
                data-testid={`graph-commit-menu-cherry-pick-${shortHash}`}
              >
                <Cherry className="icon-sm" />
                {t('graph.cherryPick', 'Cherry-pick onto current branch')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => request('checkout', hash)}
                data-testid={`graph-commit-menu-checkout-${shortHash}`}
              >
                <GitBranch className="icon-sm" />
                {t('history.checkout', 'Checkout')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => request('revert', hash)}
                data-testid={`graph-commit-menu-revert-${shortHash}`}
              >
                <RotateCcw className="icon-sm" />
                {t('history.revert', 'Revert')}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={() => request('reset', hash)}
                data-testid={`graph-commit-menu-reset-${shortHash}`}
              >
                <History className="icon-sm" />
                {t('graph.resetToHere', 'Reset branch to here')}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <CommitActionConfirm pending={pending} onConfirm={confirm} onCancel={cancel} />
      <CreateBranchDialog
        open={createBranchOpen}
        onOpenChange={setCreateBranchOpen}
        shortHash={shortHash}
        onCreate={(name) => void createBranch(name, hash)}
      />
    </>
  );
}

/** "View rebase details" for the commit's rebase events, or nothing when it has none. */
function RebaseDetailsItem({
  events,
  shortHash,
  onSelect,
}: {
  events: GitRebaseReflogEventDTO[];
  shortHash: string;
  onSelect: (event: GitRebaseReflogEventDTO) => void;
}) {
  const { t } = useTranslation();
  const primary = events[0];
  if (!primary) return null;
  const label =
    events.length > 1
      ? t('graph.viewRebaseDetailsCount', {
          count: events.length,
          defaultValue: `View rebase details (${events.length})`,
        })
      : t('graph.viewRebaseDetails', 'View rebase details');
  const scope = rebaseEventScopeLabel(primary);
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onClick={() => onSelect(primary)}
        data-testid={`graph-commit-menu-rebase-details-${shortHash}`}
      >
        <GitBranch className="icon-sm" />
        <span className="min-w-0 truncate">{scope ? `${label}: ${scope}` : label}</span>
      </DropdownMenuItem>
    </>
  );
}

/** One "Push <branch> to origin" item per local branch at the commit. */
function PushBranchItems({
  branches,
  onPush,
}: {
  branches: string[];
  onPush: (branch: string) => void;
}) {
  const { t } = useTranslation();
  if (branches.length === 0) return null;
  return (
    <>
      <DropdownMenuSeparator />
      {branches.map((branch) => (
        <DropdownMenuItem
          key={branch}
          onClick={() => onPush(branch)}
          data-testid={`graph-commit-menu-push-${branch}`}
        >
          <CloudUpload className="icon-sm" />
          {t('graph.pushBranchToOrigin', { branch, defaultValue: `Push ${branch} to origin` })}
        </DropdownMenuItem>
      ))}
    </>
  );
}

/** One "New thread from <branch>" item per branch a thread can start from. */
function NewThreadItems({
  branches,
  onCreate,
}: {
  branches: string[];
  onCreate: (branch: string) => void;
}) {
  const { t } = useTranslation();
  return branches.map((branch) => (
    <DropdownMenuItem
      key={`new-thread:${branch}`}
      onClick={() => onCreate(branch)}
      data-testid={`graph-commit-menu-new-thread-${branch}`}
    >
      <Plus className="icon-sm" />
      <span className="min-w-0 truncate">
        {t('graph.newThreadFromBranch', { branch, defaultValue: `New thread from ${branch}` })}
      </span>
    </DropdownMenuItem>
  ));
}
