import { EmptyState } from '@/components/ui/empty-state';
import { LoadingState } from '@/components/ui/loading-state';
import { Separator } from '@/components/ui/separator';

import {
  EnvFilesSection,
  PortGroupsSection,
  PostCreateSection,
} from './project-config-settings/ProjectConfigSections';
import { useProjectConfigSettings } from './project-config-settings/use-project-config';

export function ProjectConfigSettings() {
  const state = useProjectConfigSettings();
  const { t, selectedProjectId, loading } = state;

  if (!selectedProjectId) {
    return <EmptyState fill={false} className="py-6" title={t('projectConfig.noProject')} />;
  }

  if (loading) {
    return <LoadingState padding="md" fill={false} label={t('common.loading')} />;
  }

  return (
    <div className="space-y-6">
      {/* ── Env Files ── */}
      <EnvFilesSection state={state} />

      <Separator />

      {/* ── Port Groups ── */}
      <PortGroupsSection state={state} />

      <Separator />

      {/* ── Post Create ── */}
      <PostCreateSection state={state} />
    </div>
  );
}
