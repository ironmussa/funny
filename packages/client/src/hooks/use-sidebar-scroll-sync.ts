import { useEffect, type RefObject } from 'react';

import { scrollSidebarItemIntoView } from '@/lib/utils';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';

interface Options {
  selectedProjectId: string | null;
  projectsScrollRef: RefObject<HTMLDivElement | null>;
  settingsNavOpen: boolean;
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
  settingsNavOpen,
}: Options) {
  const revealNonce = useProjectStore((s) => s.revealNonce);
  const revealIntent = useProjectStore((s) => s.revealIntent);
  const toggleProject = useProjectStore((s) => s.toggleProject);
  const selectedThreadId = useThreadStore((s) => s.selectedThreadId);

  useEffect(() => {
    if (!selectedProjectId) return;
    // Read expandedProjects via getState() rather than subscribing — otherwise
    // a user-initiated collapse of the selected project would re-trigger this
    // effect and immediately re-expand it.
    if (useProjectStore.getState().expandedProjects.has(selectedProjectId)) return;
    toggleProject(selectedProjectId);
  }, [selectedProjectId, revealNonce, toggleProject]);

  useEffect(() => {
    if (settingsNavOpen) return;
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

      scrollSidebarItemIntoView(root, el, revealIntent);
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
    settingsNavOpen,
    projectsScrollRef,
  ]);
}
