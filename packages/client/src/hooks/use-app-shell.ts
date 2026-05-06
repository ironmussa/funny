import { useEffect, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { useActiveThreadBranchSync } from '@/hooks/use-active-thread-branch-sync';
import { useGlobalShortcuts } from '@/hooks/use-global-shortcuts';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';
import { useRouteSync } from '@/hooks/use-route-sync';
import { useThreadHistoryTracker } from '@/hooks/use-thread-history-tracker';
import { useWS } from '@/hooks/use-ws';
import { useAgentTemplateStore } from '@/stores/agent-template-store';
import { useProjectStore } from '@/stores/project-store';
import { setAppNavigate } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

interface ShellState {
  designViewProjectId: string | null;
  designViewOpen: boolean;
  isFullScreenView: boolean;
  rightPaneVisible: boolean;
  branchSyncDialog: ReactNode;

  // Forwarded to MainContentSwitcher
  generalSettingsOpen: boolean;
  settingsOpen: boolean;
  analyticsOpen: boolean;
  liveColumnsOpen: boolean;
  testRunnerOpen: boolean;
  automationInboxOpen: boolean;
  addProjectOpen: boolean;
  designsListOpen: boolean;
  allThreadsProjectId: string | null;
}

/**
 * Bundles every UI/store hook + mount-side effect that the App shell needs:
 *   - WebSocket connection, focus refresh, URL ↔ store sync, history tracking
 *   - Global keyboard shortcuts and active-thread branch sync
 *   - loadProjects / loadTemplates on mount
 *   - document.title sync to selected project + branch
 *   - Right-pane visibility / full-screen view derivation
 *
 * Pulling these out drops App.tsx fan-out by ~10 edges (every store +
 * bootstrap hook moves into this single import).
 */
export function useAppShell(): ShellState {
  const navigate = useNavigate();
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const loadTemplates = useAgentTemplateStore((s) => s.loadTemplates);

  const reviewPaneOpen = useUIStore((s) => s.reviewPaneOpen);
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const generalSettingsOpen = useUIStore((s) => s.generalSettingsOpen);
  const allThreadsProjectId = useUIStore((s) => s.allThreadsProjectId);
  const automationInboxOpen = useUIStore((s) => s.automationInboxOpen);
  const addProjectOpen = useUIStore((s) => s.addProjectOpen);
  const analyticsOpen = useUIStore((s) => s.analyticsOpen);
  const liveColumnsOpen = useUIStore((s) => s.liveColumnsOpen);
  const designViewDesignId = useUIStore((s) => s.designViewDesignId);
  const designViewProjectId = useUIStore((s) => s.designViewProjectId);
  const designsListProjectId = useUIStore((s) => s.designsListProjectId);
  const testRunnerOpen = useUIStore((s) => s.testRunnerOpen);

  const designViewOpen = !!designViewDesignId;
  const designsListOpen = !!designsListProjectId;
  const isFullScreenView =
    settingsOpen ||
    generalSettingsOpen ||
    analyticsOpen ||
    liveColumnsOpen ||
    testRunnerOpen ||
    automationInboxOpen ||
    addProjectOpen ||
    designsListOpen ||
    designViewOpen ||
    !!allThreadsProjectId;
  const rightPaneVisible = reviewPaneOpen && !isFullScreenView;

  // Register navigate so the store can trigger navigation (e.g. from toasts)
  useEffect(() => {
    setAppNavigate(navigate);
  }, [navigate]);

  useWS();
  useRefreshOnFocus();
  useRouteSync();
  const branchSyncDialog = useActiveThreadBranchSync();

  useEffect(() => {
    loadProjects();
    loadTemplates();
  }, [loadProjects, loadTemplates]);

  // Update browser tab title with selected project name + branch
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const selectedProjectName = useProjectStore(
    (s) => s.projects.find((p) => p.id === s.selectedProjectId)?.name,
  );
  const selectedProjectBranch = useProjectStore((s) =>
    s.selectedProjectId ? s.branchByProject[s.selectedProjectId] : undefined,
  );
  useEffect(() => {
    if (selectedProjectName && selectedProjectBranch) {
      document.title = `${selectedProjectName} [${selectedProjectBranch}] — funny`;
    } else if (selectedProjectName) {
      document.title = `${selectedProjectName} — funny`;
    } else {
      document.title = 'funny';
    }
  }, [selectedProjectId, selectedProjectName, selectedProjectBranch]);

  const toggleCommandPalette = useUIStore((s) => s.toggleCommandPalette);
  const toggleFileSearch = useUIStore((s) => s.toggleFileSearch);
  useGlobalShortcuts(toggleCommandPalette, toggleFileSearch);
  useThreadHistoryTracker();

  return {
    designViewProjectId: designViewProjectId ?? null,
    designViewOpen,
    isFullScreenView,
    rightPaneVisible,
    branchSyncDialog,
    generalSettingsOpen,
    settingsOpen,
    analyticsOpen,
    liveColumnsOpen,
    testRunnerOpen,
    automationInboxOpen,
    addProjectOpen,
    designsListOpen,
    allThreadsProjectId: allThreadsProjectId ?? null,
  };
}
