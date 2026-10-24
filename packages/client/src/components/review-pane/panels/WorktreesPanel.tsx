import { WorktreeSettings } from '@/components/WorktreeSettings';

import { useReviewPaneContext } from '../ReviewPaneStateContext';

export function WorktreesPanel() {
  const { remoteCheckProjectId, viewerReadOnly } = useReviewPaneContext();
  return (
    <div className="h-full min-h-0 w-full overflow-y-auto p-3">
      <WorktreeSettings
        key={remoteCheckProjectId ?? ''}
        projectId={remoteCheckProjectId ?? ''}
        readOnly={viewerReadOnly}
      />
    </div>
  );
}
