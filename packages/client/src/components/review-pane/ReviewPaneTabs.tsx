import { PanelRightClose } from 'lucide-react';
import type { ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ReviewSubTab } from '@/stores/ui-store';

import { CITab } from '../CITab';
import { CommitGraphTab } from '../CommitGraphTab';
import { IssuesTab } from '../IssuesTab';
import { PullRequestsTab } from '../PullRequestsTab';
import { StashTab } from './StashTab';

const TAB_TRIGGER_CLASS =
  'data-[state=active]:bg-background h-6 px-2.5 focus-visible:ring-0 data-[state=active]:shadow-xs';

const TAB_CONTENT_CLASS = 'flex min-h-0 flex-1 data-[state=inactive]:hidden';

const TABS: Array<{ value: ReviewSubTab; labelKey: string; fallback: string }> = [
  { value: 'changes', labelKey: 'review.changes', fallback: 'Changes' },
  { value: 'graph', labelKey: 'review.history', fallback: 'History' },
  { value: 'stash', labelKey: 'review.stash', fallback: 'Stash' },
  { value: 'prs', labelKey: 'review.prs', fallback: 'PRs' },
  { value: 'ci', labelKey: 'review.ci.tab', fallback: 'CI' },
  { value: 'issues', labelKey: 'review.issues.tab', fallback: 'Issues' },
];

/** Review pane header: sub-tab list + close button. */
export function ReviewPaneTabsHeader({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="border-sidebar-border flex h-12 items-center justify-between border-b px-2">
      <TabsList className="bg-sidebar-accent/50 h-7 p-0.5">
        {TABS.map((tab) => (
          <TabsTrigger
            key={tab.value}
            value={tab.value}
            className={TAB_TRIGGER_CLASS}
            data-testid={`review-tab-${tab.value}`}
          >
            {t(tab.labelKey, tab.fallback)}
          </TabsTrigger>
        ))}
      </TabsList>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            className="text-muted-foreground"
            data-testid="review-close"
          >
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
}: {
  reviewSubTab: ReviewSubTab;
  reviewPaneOpen: boolean;
  stashTab: ComponentProps<typeof StashTab>;
  projectId: string;
  prNumber: number | undefined;
  prUrl: string | undefined;
}) {
  return (
    <>
      {/* History tab (commit graph) */}
      <TabsContent value="graph" className={TAB_CONTENT_CLASS} forceMount>
        <CommitGraphTab visible={reviewSubTab === 'graph'} />
      </TabsContent>

      {/* Stash tab */}
      <TabsContent value="stash" className={TAB_CONTENT_CLASS} forceMount>
        <StashTab {...stashTab} />
      </TabsContent>

      {/* Pull Requests tab */}
      <TabsContent value="prs" className={TAB_CONTENT_CLASS} forceMount>
        <PullRequestsTab visible={reviewSubTab === 'prs'} />
      </TabsContent>

      {/* CI tab */}
      <TabsContent value="ci" className={TAB_CONTENT_CLASS} forceMount>
        <CITab
          projectId={projectId}
          prNumber={prNumber}
          prUrl={prUrl}
          visible={reviewSubTab === 'ci' && reviewPaneOpen}
        />
      </TabsContent>

      {/* Issues tab */}
      <TabsContent value="issues" className={TAB_CONTENT_CLASS} forceMount>
        <IssuesTab visible={reviewSubTab === 'issues'} />
      </TabsContent>
    </>
  );
}
