import type { GitStatusInfo } from '@funny/shared';
import { Fragment, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { GitStatChip } from '@/components/git/GitStatChip';
import { PRBadge } from '@/components/PRBadge';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { gitSyncStateConfig } from '@/lib/thread-utils';

/**
 * A thread's PR and the pending work it cannot show — uncommitted files (with
 * the +/- line counts in the tooltip) and commits not yet pushed — grouped in
 * one chip on the theme's muted fill, split by separators. Each stat keeps its
 * state color (icon and count) and tooltip. Nothing renders when none applies.
 * Used by the sidebar's thread rows and the kanban cards.
 */
export function GitStatsChip({
  gitStatus,
  id,
  testIdPrefix,
  prTestId,
  projectId,
}: {
  gitStatus: GitStatusInfo;
  /** The thread id, the last part of every test id. */
  id: string;
  /** Builds `<prefix>-stats-<id>`, `<prefix>-dirty-<id>` and `<prefix>-sync-<id>`. */
  testIdPrefix: string;
  prTestId: string;
  /** The thread's project: its PR chip opens funny's PR view. */
  projectId?: string;
}) {
  const { t } = useTranslation();
  const dirty = gitStatus.dirtyFileCount > 0;
  const unpushed = gitStatus.state !== 'clean' && gitStatus.unpushedCommitCount > 0;
  const dirtyCfg = gitSyncStateConfig.dirty;
  const unpushedCfg = gitSyncStateConfig.unpushed;
  const stats: { key: string; node: ReactNode }[] = [];
  if (gitStatus.prNumber) {
    stats.push({
      key: 'pr',
      node: (
        <PRBadge
          prNumber={gitStatus.prNumber}
          prState={gitStatus.prState ?? 'OPEN'}
          prUrl={gitStatus.prUrl}
          projectId={projectId}
          variant="plain"
          showExternalIcon={false}
          data-testid={prTestId}
        />
      ),
    });
  }
  if (dirty) {
    stats.push({
      key: 'dirty',
      node: (
        <GitStatChip
          testId={`${testIdPrefix}-dirty-${id}`}
          className={dirtyCfg.className}
          icon={dirtyCfg.icon}
          count={gitStatus.dirtyFileCount}
          tooltip={
            <>
              <div>{t(dirtyCfg.labelKey)}</div>
              <div className="font-mono">
                <span className="text-muted-foreground">
                  {t('gitStats.dirtyFiles', { count: gitStatus.dirtyFileCount })}
                  {' · '}
                </span>
                <span className="text-diff-added">+{gitStatus.linesAdded}</span>{' '}
                <span className="text-diff-removed">-{gitStatus.linesDeleted}</span>
              </div>
            </>
          }
        />
      ),
    });
  }
  if (unpushed) {
    stats.push({
      key: 'unpushed',
      node: (
        <GitStatChip
          testId={`${testIdPrefix}-sync-${id}`}
          className={unpushedCfg.className}
          icon={unpushedCfg.icon}
          count={gitStatus.unpushedCommitCount}
          tooltip={t(unpushedCfg.labelKey)}
        />
      ),
    });
  }
  if (stats.length === 0) return null;
  return (
    <Badge
      variant="subtle"
      size="stat-group"
      weight="normal"
      corners="square"
      data-testid={`${testIdPrefix}-stats-${id}`}
    >
      {stats.map(({ key, node }, i) => (
        <Fragment key={key}>
          {i > 0 && <Separator orientation="vertical" className="h-3" />}
          {node}
        </Fragment>
      ))}
    </Badge>
  );
}
