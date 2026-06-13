import { useEffect, type RefObject } from 'react';
import { useLocation } from 'react-router-dom';

import { settingsItems } from '@/components/settings/items';
import { useUIStore } from '@/stores/ui-store';

import type { ParsedRoute } from './route-parser';

const validSettingsIds = new Set([
  ...settingsItems.map((i) => i.id),
  'users',
  'team-members',
  'collaborators',
]);

function saveSettingsReturnPath(prevPath: string | null, search: string) {
  const ui = useUIStore.getState();
  if (prevPath && ui.settingsReturnPath === null) {
    ui.setSettingsReturnPath(prevPath + (search || ''));
  }
}

export function useViewRouteSync(
  initialized: boolean,
  parsed: ParsedRoute,
  prevNonSettingsPathRef: RefObject<string | null>,
) {
  const location = useLocation();

  useEffect(() => {
    if (!initialized) return;
    const ui = useUIStore.getState();
    if (parsed.preferencesPage) {
      if (!ui.generalSettingsOpen) {
        saveSettingsReturnPath(prevNonSettingsPathRef.current, location.search);
        ui.setGeneralSettingsOpen(true);
      }
      if (ui.activePreferencesPage !== parsed.preferencesPage) {
        ui.setActivePreferencesPage(parsed.preferencesPage);
      }
    } else if (ui.generalSettingsOpen) {
      ui.setGeneralSettingsOpen(false);
    }
  }, [initialized, parsed.preferencesPage, location.search, prevNonSettingsPathRef]);

  useEffect(() => {
    if (!initialized) return;
    const ui = useUIStore.getState();
    const valid = parsed.settingsPage && validSettingsIds.has(parsed.settingsPage);
    if (valid) {
      if (!ui.settingsOpen) {
        saveSettingsReturnPath(prevNonSettingsPathRef.current, location.search);
        ui.setSettingsOpen(true);
      }
      if (ui.activeSettingsPage !== parsed.settingsPage) {
        ui.setActiveSettingsPage(parsed.settingsPage!);
      }
    } else if (ui.settingsOpen) {
      ui.setSettingsOpen(false);
    }
  }, [initialized, parsed.settingsPage, location.search, prevNonSettingsPathRef]);

  useEffect(() => {
    if (!initialized) return;
    const ui = useUIStore.getState();
    if (parsed.inbox) {
      if (!ui.automationInboxOpen) ui.setAutomationInboxOpen(true);
      if (ui.allThreadsProjectId) ui.closeAllThreads();
    } else if (ui.automationInboxOpen) {
      ui.setAutomationInboxOpen(false);
    }
  }, [initialized, parsed.inbox]);

  useEffect(() => {
    if (!initialized) return;
    const ui = useUIStore.getState();
    if (parsed.analytics) {
      if (!ui.analyticsOpen) ui.setAnalyticsOpen(true);
      if (ui.allThreadsProjectId) ui.closeAllThreads();
    } else if (ui.analyticsOpen) {
      ui.setAnalyticsOpen(false);
    }
  }, [initialized, parsed.analytics]);

  useEffect(() => {
    if (!initialized) return;
    const ui = useUIStore.getState();
    if (parsed.liveColumns) {
      if (!ui.liveColumnsOpen) ui.setLiveColumnsOpen(true);
      if (ui.allThreadsProjectId) ui.closeAllThreads();
    } else if (ui.liveColumnsOpen) {
      ui.setLiveColumnsOpen(false);
    }
  }, [initialized, parsed.liveColumns]);

  useEffect(() => {
    if (!initialized) return;
    const ui = useUIStore.getState();
    if (parsed.orchestrator) {
      if (!ui.orchestratorOpen) ui.setOrchestratorOpen(true);
      if (ui.allThreadsProjectId) ui.closeAllThreads();
    } else if (ui.orchestratorOpen) {
      ui.setOrchestratorOpen(false);
    }
  }, [initialized, parsed.orchestrator]);

  useEffect(() => {
    if (!initialized) return;
    const ui = useUIStore.getState();
    if (parsed.addProject) {
      if (!ui.addProjectOpen) ui.setAddProjectOpen(true);
    } else if (ui.addProjectOpen) {
      ui.setAddProjectOpen(false);
    }
  }, [initialized, parsed.addProject]);

  useEffect(() => {
    if (!initialized) return;
    const ui = useUIStore.getState();
    if (parsed.scratchNew) {
      if (!ui.newThreadIsScratch) ui.startNewScratchThread();
    } else if (ui.newThreadIsScratch && !parsed.threadId) {
      ui.cancelNewThread();
    }
  }, [initialized, parsed.scratchNew, parsed.threadId]);

  useEffect(() => {
    if (!initialized) return;
    const ui = useUIStore.getState();
    if (parsed.globalSearch) {
      ui.showGlobalSearch();
      if (ui.kanbanContext) ui.setKanbanContext(null);
    } else if (ui.allThreadsProjectId) {
      ui.closeAllThreads();
    }
  }, [initialized, parsed.globalSearch]);

  useEffect(() => {
    if (!initialized) return;
    const ui = useUIStore.getState();
    if (parsed.designId && parsed.projectId) {
      if (
        ui.designViewProjectId !== parsed.projectId ||
        ui.designViewDesignId !== parsed.designId
      ) {
        ui.setDesignView(parsed.projectId, parsed.designId);
      }
    } else if (ui.designViewDesignId) {
      ui.closeDesignView();
    }
  }, [initialized, parsed.designId, parsed.projectId]);

  useEffect(() => {
    if (!initialized) return;
    const ui = useUIStore.getState();
    if (parsed.designsList && parsed.projectId) {
      if (ui.designsListProjectId !== parsed.projectId) {
        ui.setDesignsListOpen(parsed.projectId);
      }
    } else if (ui.designsListProjectId) {
      ui.closeDesignsList();
    }
  }, [initialized, parsed.designsList, parsed.projectId]);
}
