import { PanelRightClose } from 'lucide-react';
import type { ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ReviewSubTab } from '@/stores/ui-store';

import { ActionsTab } from '../ActionsTab';
import { CommitGraphTab } from '../CommitGraphTab';
import { IssuesTab } from '../IssuesTab';
import { PullRequestsTab } from '../PullRequestsTab';
import { WorktreeSettings } from '../WorktreeSettings';
import { StashTab } from './StashTab';

const TAB_CONTENT_CLASS = 'flex min-h-0 flex-1 data-hidden:hidden';

const TABS: Array<{ value: ReviewSubTab; labelKey: string; fallback: string }> = [
  { value: 'changes', labelKey: 'review.changes', fallback: 'Changes' },
  { value: 'graph', labelKey: 'review.history', fallback: 'History' },
  { value: 'stash', labelKey: 'review.stash', fallback: 'Stash' },
  { value: 'worktrees', labelKey: 'settings.worktrees', fallback: 'Worktrees' },
  { value: 'prs', labelKey: 'review.prs', fallback: 'PRs' },
  { value: 'ci', labelKey: 'review.actions.tab', fallback: 'Actions' },
  { value: 'issues', labelKey: 'review.issues.tab', fallback: 'Issues' },
];

/** Review pane header: sub-tab list + close button. */
export function ReviewPaneTabsHeader({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="border-sidebar-border flex h-12 items-center justify-between border-b px-2">
      <TabsList variant="pane" size="sm" className="min-w-0 justify-start overflow-x-auto">
        {TABS.map((tab) => (
          <TabsTrigger
            key={tab.value}
            value={tab.value}
            size="sm"
            focusRing={false}
            data-testid={`review-tab-${tab.value}`}
          >
            {t(tab.labelKey, tab.fallback)}
          </TabsTrigger>
        ))}
      </TabsList>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="muted" size="icon-sm" onClick={onClose} data-testid="review-close">
            <PanelRightClose className="icon-base" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">{t('review.close', 'Close')}</TooltipContent>
      </Tooltip>
    </div>
  );
}

/**
 * The non-Changes sub-tabs (History, Stash, PRs, CI, Issues). All are
 * force-mounted and hidden while inactive so their state survives tab switches.
 */
export function ReviewSecondaryTabs({
  reviewSubTab,
  reviewPaneOpen,
  stashTab,
  projectId,
  prNumber,
  prUrl,
  readOnly = false,
  activePath,
}: {
  reviewSubTab: ReviewSubTab;
  reviewPaneOpen: boolean;
  stashTab: ComponentProps<typeof StashTab>;
  projectId: string;
  prNumber: number | undefined;
  prUrl: string | undefined;
  readOnly?: boolean;
  activePath?: string;
}) {
  return (
    <>
      {/* History tab (commit graph) */}
      <TabsContent value="graph" className={TAB_CONTENT_CLASS} keepMounted>
        <CommitGraphTab visible={reviewSubTab === 'graph'} />
      </TabsContent>

      {/* Stash tab */}
      <TabsContent value="stash" className={TAB_CONTENT_CLASS} keepMounted>
        <StashTab {...stashTab} />
      </TabsContent>

      <TabsContent value="worktrees" className={TAB_CONTENT_CLASS}>
        <WorktreeSettings
          key={projectId}
          projectId={projectId}
          readOnly={readOnly}
          activePath={activePath}
        />
      </TabsContent>

      {/* Pull Requests tab */}
      <TabsContent value="prs" className={TAB_CONTENT_CLASS} keepMounted>
        <PullRequestsTab visible={reviewSubTab === 'prs'} />
      </TabsContent>

      {/* Actions tab (workflow runs + the PR's checks) */}
      <TabsContent value="ci" className={TAB_CONTENT_CLASS} keepMounted>
        <ActionsTab
          projectId={projectId}
          prNumber={prNumber}
          prUrl={prUrl}
          currentBranch={stashTab.currentBranch ?? undefined}
          visible={reviewSubTab === 'ci' && reviewPaneOpen}
          readOnly={readOnly}
        />
      </TabsContent>

      {/* Issues tab */}
      <TabsContent value="issues" className={TAB_CONTENT_CLASS} keepMounted>
        <IssuesTab visible={reviewSubTab === 'issues'} />
      </TabsContent>
    </>
  );
}
