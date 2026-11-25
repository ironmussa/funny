import { GitBranch } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import {
  type GraphEntry,
  PARENT_BRANCH_LABEL_MAX_CHARS,
} from '@/components/commit-graph/graph-entry';
import { initialsOf } from '@/components/commit-graph/GraphGutter';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { GraphNodeParentLabel } from '@/lib/graph-refs';
import { middleTruncate } from '@/lib/text-truncate';
import { cn } from '@/lib/utils';

/** A branch's lane color dot; muted when the branch has no row in view. */
function BranchColorDot({ color }: { color: string | undefined }) {
  return (
    <span
      aria-hidden
      className={cn(
        'size-2 shrink-0 rounded-full',
        color ? 'bg-[color:var(--graph-tooltip-dot-color)]' : 'bg-muted-foreground',
      )}
      style={color ? { '--graph-tooltip-dot-color': color } : undefined}
    />
  );
}

/**
 * The branches a node's parent sits on, each marked with its lane color: the
 * same hue as its chip and graph line, so the entry reads as a branch rather
 * than a bullet point.
 */
function ParentBranchList({
  branches,
  colorByLabel,
}: {
  branches: readonly string[];
  colorByLabel: ReadonlyMap<string, string>;
}) {
  if (branches.length === 0) return null;
  return (
    <ul className="space-y-0.5" data-testid="graph-node-parent-branches">
      {branches.map((branch) => (
        <Tooltip key={branch}>
          <TooltipTrigger asChild>
            <li className="flex items-center gap-1.5">
              <BranchColorDot color={colorByLabel.get(branch)} />
              <span>{middleTruncate(branch, PARENT_BRANCH_LABEL_MAX_CHARS)}</span>
            </li>
          </TooltipTrigger>
          <TooltipContent variant="mono">{branch}</TooltipContent>
        </Tooltip>
      ))}
    </ul>
  );
}

/** A person line in a graph node's tooltip: their avatar (initials if none) + label. */
function NodeTooltipPerson({
  name,
  avatarUrl,
  testId,
  children,
}: {
  name: string;
  avatarUrl: string | undefined;
  testId: string;
  children: ReactNode;
}) {
  return (
    <span className="flex items-center gap-1.5" data-testid={testId}>
      <Avatar size="xs">
        {avatarUrl ? <AvatarImage src={avatarUrl} alt="" /> : null}
        <AvatarFallback name={name} textSize="micro">
          {initialsOf(name)}
        </AvatarFallback>
      </Avatar>
      <span>{children}</span>
    </span>
  );
}

/** What a graph node's tooltip says: author, committer, where it branched from, its parent. */
export function GraphNodeTooltipContent({
  entry,
  avatarUrl,
  committerAvatarUrl,
  hasDistinctCommitter,
  forkedFromRefLabel,
  parentLabel,
  branchColorByLabel,
  unpushed,
}: {
  entry: Pick<GraphEntry, 'author' | 'committer'>;
  avatarUrl: string | undefined;
  committerAvatarUrl: string | undefined;
  hasDistinctCommitter: boolean;
  forkedFromRefLabel: string | null;
  parentLabel: GraphNodeParentLabel | null;
  branchColorByLabel: ReadonlyMap<string, string>;
  unpushed: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-0.5">
      <NodeTooltipPerson
        name={entry.author}
        avatarUrl={avatarUrl}
        testId="graph-node-tooltip-author"
      >
        {t('graph.nodeAuthor', {
          author: entry.author,
          defaultValue: `Author: ${entry.author}`,
        })}
      </NodeTooltipPerson>
      {hasDistinctCommitter ? (
        <NodeTooltipPerson
          name={entry.committer}
          avatarUrl={committerAvatarUrl}
          testId="graph-node-tooltip-committer"
        >
          {t('graph.nodeCommitter', {
            committer: entry.committer,
            defaultValue: `Committed by: ${entry.committer}`,
          })}
        </NodeTooltipPerson>
      ) : null}
      {forkedFromRefLabel ? (
        <span className="flex items-center gap-1.5" data-testid="graph-node-tooltip-branched-from">
          {(() => {
            // The label may join several refs ("a, b"); the
            // first one is the branch whose lane color to use.
            const color = branchColorByLabel.get(forkedFromRefLabel.split(', ')[0]);
            return (
              <GitBranch
                aria-hidden
                className={cn(
                  'h-3 w-3 shrink-0',
                  color
                    ? 'text-[color:var(--graph-tooltip-branch-color)]'
                    : 'text-muted-foreground',
                )}
                style={color ? { '--graph-tooltip-branch-color': color } : undefined}
              />
            );
          })()}
          <span className="sr-only">
            {t('graph.nodeBranchedFrom', {
              branch: forkedFromRefLabel,
              defaultValue: `Branched from: ${forkedFromRefLabel}`,
            })}
          </span>
          <span aria-hidden>{forkedFromRefLabel}</span>
        </span>
      ) : null}
      {parentLabel ? (
        <>
          <span>
            {t('graph.nodeParent', {
              parent: parentLabel.commit,
              defaultValue: `Parent: ${parentLabel.commit}`,
            })}
          </span>
          <ParentBranchList branches={parentLabel.branchLabels} colorByLabel={branchColorByLabel} />
        </>
      ) : null}
      {unpushed && <span>{t('history.unpushed', 'Not pushed')}</span>}
    </div>
  );
}
