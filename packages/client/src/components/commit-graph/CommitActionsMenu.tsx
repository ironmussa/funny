import {
  Copy,
  ExternalLink,
  GitBranch,
  Hash,
  History,
  MoreVertical,
  RotateCcw,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

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
import { cn } from '@/lib/utils';

interface Props {
  hash: string;
  shortHash: string;
  /** Resolved GitHub commit URL, or null when the repo has no GitHub remote. */
  githubUrl: string | null;
  effectiveThreadId?: string;
  projectModeId: string | null;
  /** Reload the graph log after a mutating action. */
  onAfterAction: () => void;
}

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
  onAfterAction,
}: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { pending, request, cancel, confirm, hasGitContext } = useCommitActions({
    effectiveThreadId,
    projectModeId,
    onAfterAction,
  });

  const copy = (value: string) =>
    void navigator.clipboard.writeText(value).then(
      () =>
        toast.success(
          t('history.hashCopied', { hash: shortHash, defaultValue: `Copied ${shortHash}` }),
        ),
      () => toast.error(t('history.hashCopyFailed', 'Failed to copy hash')),
    );

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              'text-muted-foreground hover:text-foreground ml-auto shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100',
              open && 'opacity-100',
            )}
            data-testid={`graph-commit-more-${shortHash}`}
          >
            <MoreVertical className="icon-sm" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          side="bottom"
          className="w-52"
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
          {hasGitContext && (
            <>
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
    </>
  );
}
