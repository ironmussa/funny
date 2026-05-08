import { autoScrollForElements } from '@atlaskit/pragmatic-drag-and-drop-auto-scroll/element';
import { monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import type { Project } from '@funny/shared';
import { useEffect, type RefObject } from 'react';

interface Options {
  projectsScrollRef: RefObject<HTMLDivElement | null>;
  threadsScrollRef: RefObject<HTMLDivElement | null>;
  projects: Project[];
  reorderProjects: (ids: string[]) => void;
}

/**
 * Sidebar drag-and-drop wiring: auto-scrolls the projects/threads scroll
 * containers while dragging near their edges, and reorders projects on drop.
 *
 * Extracted from Sidebar.tsx so the parent doesn't need to import the
 * atlaskit packages directly (drops 2 fan-out edges).
 */
export function useSidebarDragDrop({
  projectsScrollRef,
  threadsScrollRef,
  projects,
  reorderProjects,
}: Options) {
  useEffect(() => {
    type Target = {
      el: HTMLElement;
      type: 'sidebar-project' | 'grid-thread';
      cleanup?: () => void;
    };
    const targets: Target[] = [];
    if (projectsScrollRef.current)
      targets.push({ el: projectsScrollRef.current, type: 'sidebar-project' });
    if (threadsScrollRef.current)
      targets.push({ el: threadsScrollRef.current, type: 'grid-thread' });

    const sync = (t: Target) => {
      const scrollable = t.el.scrollHeight > t.el.clientHeight;
      if (scrollable && !t.cleanup) {
        t.cleanup = autoScrollForElements({
          element: t.el,
          canScroll: ({ source }) => source.data.type === t.type,
        });
      } else if (!scrollable && t.cleanup) {
        t.cleanup();
        t.cleanup = undefined;
      }
    };

    const ro = new ResizeObserver(() => {
      for (const t of targets) sync(t);
    });
    const mos: MutationObserver[] = [];
    for (const t of targets) {
      sync(t);
      ro.observe(t.el);
      for (const c of Array.from(t.el.children)) ro.observe(c);
      const mo = new MutationObserver(() => {
        for (const c of Array.from(t.el.children)) ro.observe(c);
        sync(t);
      });
      mo.observe(t.el, { childList: true, subtree: true });
      mos.push(mo);
    }

    return () => {
      ro.disconnect();
      for (const m of mos) m.disconnect();
      for (const t of targets) t.cleanup?.();
    };
  }, [projectsScrollRef, threadsScrollRef]);

  useEffect(() => {
    return monitorForElements({
      onDrop: ({ source, location }) => {
        const targets = location.current.dropTargets;
        if (!targets.length) return;
        if (source.data.type !== 'sidebar-project') return;

        const targetData = targets[0].data;
        if (targetData.type !== 'sidebar-project') return;

        const sourceId = source.data.projectId as string;
        const targetId = targetData.projectId as string;
        if (sourceId === targetId) return;

        const oldIndex = projects.findIndex((p) => p.id === sourceId);
        const newIndex = projects.findIndex((p) => p.id === targetId);
        if (oldIndex === -1 || newIndex === -1) return;

        const reordered = [...projects];
        const [moved] = reordered.splice(oldIndex, 1);
        reordered.splice(newIndex, 0, moved);
        reorderProjects(reordered.map((p) => p.id));
      },
    });
  }, [projects, reorderProjects]);
}
