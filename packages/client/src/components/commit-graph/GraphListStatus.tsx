import type { TFunction } from 'i18next';
import { AlertTriangle, GitCommit, RefreshCw, Search } from 'lucide-react';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadingState } from '@/components/ui/loading-state';

/**
 * What the graph's scroll area shows instead of the commit list: the first
 * page loading, a load error with a retry, or an empty (or fully filtered
 * out) history. Null when the list itself should render.
 */
export function graphListStatus({
  t,
  loadingFirstPage,
  logErrorMessage,
  isEmpty,
  isFiltering,
  onRetry,
}: {
  t: TFunction;
  loadingFirstPage: boolean;
  logErrorMessage: string | null;
  isEmpty: boolean;
  isFiltering: boolean;
  onRetry: () => void;
}): ReactNode | null {
  if (loadingFirstPage) {
    return (
      <LoadingState testId="graph-loading" label={t('review.loadingLog', 'Loading commits…')} />
    );
  }
  if (logErrorMessage) {
    return (
      <EmptyState
        testId="graph-load-error"
        icon={AlertTriangle}
        title={t('review.logLoadFailed', 'Failed to load history')}
        description={logErrorMessage}
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={onRetry}
            gap="snug"
            data-testid="graph-retry"
          >
            <RefreshCw className="icon-xs" />
            {t('common.retry', 'Retry')}
          </Button>
        }
      />
    );
  }
  if (!isEmpty) return null;
  return isFiltering ? (
    <EmptyState icon={Search} title={t('graph.noFilterMatches', 'No commits match the filters')} />
  ) : (
    <EmptyState fill={false} icon={GitCommit} title={t('review.noCommits', 'No commits yet')} />
  );
}
