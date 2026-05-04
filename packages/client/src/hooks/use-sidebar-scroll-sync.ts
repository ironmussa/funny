import { useEffect, type RefObject } from 'react';

import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';

interface Options {
  selectedProjectId: string | null;
  projectsScrollRef: RefObject<HTMLDivElement | null>;
  settingsOpen: boolean;
}

/**
 * Auto-expands the selected project and scrolls it into view in the projects
 * pane after Ctrl+K, after returning from settings, and whenever revealNonce
 * bumps (re-selecting the same project).
 *
 * Two effects:
 *   1. expand the selected project if it isn't already
 *   2. scroll-into-view via rAF + delayed retry (waits for Collapsible
 *      transition to finish before measuring)
 */
export function useSidebarScrollSync({
  selectedProjectId,
  projectsScrollRef,
  settingsOpen,
}: Options) {
  const revealNonce = useProjectStore((s) => s.revealNonce);
  const revealIntent = useProjectStore((s) => s.revealIntent);
  const expandedProjects = useProjectStore((s) => s.expandedProjects);
  const toggleProject = useProjectStore((s) => s.toggleProject);
  const selectedThreadId = useThreadStore((s) => s.selectedThreadId);

  useEffect(() => {
    if (!selectedProjectId) return;
    if (expandedProjects.has(selectedProjectId)) return;
    toggleProject(selectedProjectId);
  }, [selectedProjectId, revealNonce, expandedProjects, toggleProject]);

  useEffect(() => {
    if (settingsOpen) return;
    if (!selectedProjectId) return;
    let scrolled = false;
    const scrollToTarget = (isRetry = false): boolean => {
      if (scrolled) return true;
      const root = projectsScrollRef.current;
      if (!root) return false;

      const threadEl = selectedThreadId
        ? root.querySelector(
            `[data-project-id="${selectedProjectId}"] [data-testid="thread-item-${selectedThreadId}"]`,
          )
        : null;

      // If we are looking for a thread but it hasn't rendered yet (e.g. project is
      // currently expanding), don't fallback to the project header on the first frame.
      if (selectedThreadId && !threadEl && !isRetry) {
        return false;
      }

      const el =
        threadEl ??
        root.querySelector(`[data-testid="project-item-${selectedProjectId}"]`) ??
        root.querySelector(`[data-project-id="${selectedProjectId}"]`);

      if (!el) return false;

      el.scrollIntoView({ block: revealIntent, behavior: 'smooth' });
      scrolled = true;
      return true;
    };

    const raf = requestAnimationFrame(() => {
      scrollToTarget(false);
    });
    const timeout = window.setTimeout(() => scrollToTarget(true), 300);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timeout);
    };
  }, [
    selectedProjectId,
    selectedThreadId,
    revealNonce,
    revealIntent,
    settingsOpen,
    projectsScrollRef,
  ]);
}
