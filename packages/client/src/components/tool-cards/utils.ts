import { useMemo } from 'react';

import { useProjectStore } from '@/stores/project-store';
import {
  useThreadProjectId,
  useThreadSelector,
  useThreadWorktreePath,
} from '@/stores/thread-context';

export * from './format-utils';

/**
 * Hook that returns the current thread's project path (for stripping from absolute file paths).
 */
export function useCurrentProjectPath(): string | undefined {
  const projectId = useThreadProjectId();
  const worktreePath = useThreadWorktreePath();
  const projects = useProjectStore((s) => s.projects);
  return useMemo(
    () => worktreePath || projects.find((p) => p.id === projectId)?.path,
    [projects, projectId, worktreePath],
  );
}

/**
 * Hook returning the active thread's effective provider/model — used by tool
 * cards so their slash-command loaders resolve provider-scoped Agent Resources
 * (e.g. no Claude `.claude` skills when the thread runs on Codex).
 */
export function useCurrentThreadProviderModel(): { provider?: string; model?: string } {
  const provider = useThreadSelector((thr) => thr?.provider) ?? undefined;
  const model = useThreadSelector((thr) => thr?.model) ?? undefined;
  return useMemo(() => ({ provider, model }), [provider, model]);
}

/**
 * Strips the project root prefix from an absolute file path to display a shorter relative path.
 * Falls back to the original path if the project path is not a prefix.
 */
export function makeRelativePath(filePath: string, projectPath: string | undefined): string {
  if (!projectPath) return filePath;
  const normalizedFile = filePath.replace(/\\/g, '/');
  const normalizedProject = projectPath.replace(/\\/g, '/').replace(/\/$/, '');
  if (normalizedFile.startsWith(normalizedProject + '/')) {
    return normalizedFile.slice(normalizedProject.length + 1);
  }
  return filePath;
}
