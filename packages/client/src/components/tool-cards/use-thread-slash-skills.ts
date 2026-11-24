import { useSlashSkills } from '@/hooks/use-slash-skills';

import { useCurrentProjectId, useCurrentProjectPath, useCurrentThreadProviderModel } from './utils';

/**
 * Provider-scoped skills/commands for a tool card's slash commands, plus the
 * project path the card's editor resolves mentions against. Single cache;
 * lazy — these cards mount in bulk and most are never typed into, so only
 * fetch on the first `/`.
 */
export function useThreadSlashSkills() {
  const cwd = useCurrentProjectPath();
  const projectId = useCurrentProjectId();
  const { provider: threadProvider, model: threadModel } = useCurrentThreadProviderModel();
  const { slashSkills, slashSkillsLoading, ensureSlashSkills } = useSlashSkills({
    projectPath: cwd,
    projectId,
    provider: threadProvider,
    model: threadModel,
    mode: 'lazy',
  });
  return { cwd, slashSkills, slashSkillsLoading, ensureSlashSkills };
}
