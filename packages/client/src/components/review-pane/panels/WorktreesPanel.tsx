import { WorktreeSettings } from '@/components/WorktreeSettings';

import { useReviewPaneContext } from '../ReviewPaneStateContext';

export function WorktreesPanel() {
  const { remoteCheckProjectId, viewerReadOnly } = useReviewPaneContext();
  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <WorktreeSettings
        key={remoteCheckProjectId ?? ''}
        projectId={remoteCheckProjectId ?? ''}
        readOnly={viewerReadOnly}
      />
    </div>
  );
}
