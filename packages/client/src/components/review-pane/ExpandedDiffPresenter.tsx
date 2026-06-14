import { useIsMobile } from '@/hooks/use-mobile';

import { DiffViewerModal, type DiffViewerModalProps } from './DiffViewerModal';
import { MobileDiffView } from './MobileDiffView';

/**
 * Chooses the expanded-diff presentation by viewport. The two share one data
 * contract (`DiffViewerModalProps`); only the chrome differs:
 *
 *   desktop → DiffViewerModal   centered Dialog + 280px file-tree sidebar, full staging
 *   mobile  → MobileDiffView    full-screen overlay, read-only, prev/next arrows
 *
 * Single switch so neither mount site (`ReviewPane`, `ReviewPaneStateContext`)
 * duplicates the `useIsMobile()` branch.
 */
export function ExpandedDiffPresenter(props: DiffViewerModalProps) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <MobileDiffView
        expandedFile={props.expandedFile}
        expandedSummary={props.expandedSummary}
        expandedDiffContent={props.expandedDiffContent}
        ExpandedIcon={props.ExpandedIcon}
        onClose={props.onClose}
        onFileSelect={props.onFileSelect}
        filteredDiffs={props.filteredDiffs}
        summaries={props.summaries}
        loadingDiff={props.loadingDiff}
        diffCache={props.diffCache}
        prThreads={props.prThreads}
        requestFullDiff={props.requestFullDiff}
        handleResolveConflict={props.handleResolveConflict}
      />
    );
  }

  return <DiffViewerModal {...props} />;
}
