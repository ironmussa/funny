import type { Project } from '@funny/shared';
import type { WorkflowSummary } from '@funny/shared/types/workflows';
import { useEffect, useMemo, useState } from 'react';

import { useAdjustOnChange } from '@/hooks/use-resettable-state';
import { useSlashSkills } from '@/hooks/use-slash-skills';
import { api } from '@/lib/api';

const EMPTY_WORKFLOW_SUGGESTIONS: WorkflowSummary[] = [];

/** Workflows of the resolved project, offered as `/` suggestions. */
function useWorkflowSuggestions(projectId: string | null | undefined) {
  const [workflowSuggestions, setWorkflowSuggestions] = useState<WorkflowSummary[]>(
    EMPTY_WORKFLOW_SUGGESTIONS,
  );
  const [workflowSuggestionsLoading, setWorkflowSuggestionsLoading] = useState(!!projectId);

  // A project change shows its loading state (or the empty list) during render
  // (react.dev "adjusting state when a prop changes"); the effect only fetches.
  useAdjustOnChange([projectId], () => {
    if (projectId) {
      setWorkflowSuggestionsLoading(true);
    } else {
      setWorkflowSuggestions(EMPTY_WORKFLOW_SUGGESTIONS);
      setWorkflowSuggestionsLoading(false);
    }
  });

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    void api.listWorkflows(projectId).then((result) => {
      if (cancelled) return;
      setWorkflowSuggestions(result.isOk() ? result.value.workflows : EMPTY_WORKFLOW_SUGGESTIONS);
      setWorkflowSuggestionsLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return { workflowSuggestions, workflowSuggestionsLoading };
}

/**
 * Skills (provider-scoped, single cache) + workflow suggestions for the `/`
 * menu. The composer is always mounted, so skills load eagerly: the `/` menu
 * is ready the instant it's opened, and switching project/provider/model
 * auto-invalidates the cache. `useSlashSkills` is the ONE cache — the editor
 * no longer keeps its own copy. `ensureSlashSkills` feeds both the editor and
 * the submit path (which resolves a leading slash command's thread mode).
 */
export function usePromptSlashSources({
  isNewThread,
  activeThreadWorktreePath,
  selectedProjectId,
  resolvedProjectId,
  projects,
  provider,
  model,
}: {
  isNewThread: boolean;
  activeThreadWorktreePath: string | null | undefined;
  selectedProjectId: string | null | undefined;
  resolvedProjectId: string | null | undefined;
  projects: Project[];
  provider: string;
  model: string;
}) {
  const composerProjectPath = useMemo(
    () =>
      (!isNewThread ? activeThreadWorktreePath : undefined) ??
      (selectedProjectId ? projects.find((p) => p.id === selectedProjectId)?.path : undefined),
    [activeThreadWorktreePath, isNewThread, selectedProjectId, projects],
  );
  const slash = useSlashSkills({
    projectPath: composerProjectPath,
    projectId: selectedProjectId ?? undefined,
    provider,
    model,
    mode: 'eager',
  });
  const workflows = useWorkflowSuggestions(resolvedProjectId);
  return {
    slashSkills: slash.slashSkills,
    slashSkillsLoading: slash.slashSkillsLoading,
    ensureSlashSkills: slash.ensureSlashSkills,
    ...workflows,
  };
}
