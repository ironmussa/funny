/**
 * The branch the caller's issue factory merges into: its runs start from it
 * and their pull requests target it. "Repository default" (empty) follows the
 * repository's default branch on GitHub. Flows are still read from the
 * default branch, so a feature branch cannot change what a run executes.
 */
import { useTranslation } from 'react-i18next';

import { BranchPicker } from '@/components/SearchablePicker';
import { useDataQuery } from '@/data/hooks';
import { projectBranchesQuery } from '@/data/projects/branches';

import { ProjectSettingRow } from './setting-primitives';

const REPO_DEFAULT = '__repo_default__';

const NO_BRANCHES: string[] = [];

export function ProjectFactoryBaseBranch({
  projectId,
  baseBranch,
  onSave,
}: {
  projectId: string;
  /** The configured branch; empty for the repository's default. */
  baseBranch: string;
  onSave: (baseBranch: string) => void;
}) {
  const { t } = useTranslation();
  const { data } = useDataQuery(projectBranchesQuery(projectId));
  const remote = data?.remoteBranches ?? NO_BRANCHES;
  // The factory merges on GitHub: the branches on origin first, then local ones.
  const branches = [...new Set([...remote, ...(data?.branches ?? NO_BRANCHES)])];
  const repoDefault = t('settings.projectFactoryBaseBranchDefault', 'Repository default');
  return (
    <ProjectSettingRow
      settingId="factory.baseBranch"
      title={t('settings.projectFactoryBaseBranch', 'Merge into')}
      description={t(
        'settings.projectFactoryBaseBranchDesc',
        'The branch runs start from and their pull requests merge into. Flows are still read from the default branch',
      )}
    >
      <BranchPicker
        branches={branches}
        remoteBranches={remote}
        defaultBranch={data?.defaultBranch}
        selected={baseBranch}
        onChange={(branch) => {
          const next = branch === REPO_DEFAULT ? '' : branch;
          if (next !== baseBranch) onSave(next);
        }}
        extraItems={[
          {
            key: REPO_DEFAULT,
            label: repoDefault,
            detail: data?.defaultBranch ?? undefined,
            isSelected: !baseBranch,
          },
        ]}
        placeholder={repoDefault}
        triggerClassName="flex h-9 w-[220px] items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-xs hover:bg-accent/50"
        side="bottom"
        align="end"
        showCopy={false}
        testId="settings-factory-base-branch"
      />
    </ProjectSettingRow>
  );
}
