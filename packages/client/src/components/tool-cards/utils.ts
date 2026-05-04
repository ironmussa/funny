import { useMemo } from 'react';

import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';

export * from './format-utils';

/**
 * Hook that returns the current thread's project path (for stripping from absolute file paths).
 */
export function useCurrentProjectPath(): string | undefined {
  const projectId = useThreadStore((s) => s.activeThread?.projectId);
  const worktreePath = useThreadStore((s) => s.activeThread?.worktreePath);
  const projects = useProjectStore((s) => s.projects);
  return useMemo(
    () => worktreePath || projects.find((p) => p.id === projectId)?.path,
    [projects, projectId, worktreePath],
  );
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
