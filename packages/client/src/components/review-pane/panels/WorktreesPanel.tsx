import { WorktreeSettings } from '@/components/WorktreeSettings';

import { useReviewPaneContext } from '../ReviewPaneStateContext';

export function WorktreesPanel() {
  const { remoteCheckProjectId, viewerReadOnly, basePath } = useReviewPaneContext();
  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <WorktreeSettings
        key={remoteCheckProjectId ?? ''}
        projectId={remoteCheckProjectId ?? ''}
        readOnly={viewerReadOnly}
        activePath={basePath}
      />
    </div>
  );
}
