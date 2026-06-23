import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

import { useProjectStore } from '@/stores/project-store';
import { getSelectingThreadId, useThreadStore } from '@/stores/thread-store';
import { useUIStore, type ReviewSubTab } from '@/stores/ui-store';

import type { ParsedRoute } from './route-parser';

type UIState = ReturnType<typeof useUIStore.getState>;

function isOverlayActive(parsed: ParsedRoute): boolean {
  return Boolean(
    parsed.preferencesPage ||
    parsed.settingsPage ||
    parsed.inbox ||
    parsed.analytics ||
    parsed.liveColumns ||
    parsed.orchestrator ||
    parsed.addProject ||
    parsed.scratchNew ||
    parsed.globalSearch ||
    parsed.designId ||
    parsed.designsList ||
    parsed.externalClaudeSessionId,
  );
}

function syncPanelParam(search: string, ui: UIState) {
  const panelParam = new URLSearchParams(search).get('panel');
  if (panelParam === 'review') {
    if (!ui.reviewPaneOpen || ui.rightPaneTab !== 'review') ui.setReviewPaneOpen(true);
  } else if (panelParam === 'files') {
    if (!ui.reviewPaneOpen || ui.rightPaneTab !== 'files') ui.setFilesPaneOpen(true);
  } else if (panelParam === 'tests') {
    if (!ui.testRunnerOpen) ui.setTestRunnerOpen(true);
  }
}

const VALID_TABS: ReviewSubTab[] = ['changes', 'graph', 'stash', 'prs', 'issues'];

function syncTabParam(search: string, ui: UIState) {
  const tabParam = new URLSearchParams(search).get('tab') as ReviewSubTab | null;
  if (!tabParam || !VALID_TABS.includes(tabParam) || tabParam === ui.reviewSubTab) return;
  ui.setReviewSubTab(tabParam);
  if (!ui.reviewPaneOpen || ui.rightPaneTab !== 'review') {
    ui.setReviewPaneOpen(true);
  }
}

function applyThreadRoute(parsed: ParsedRoute, search: string) {
  const ts = useThreadStore.getState();
  const ps = useProjectStore.getState();
  const ui = useUIStore.getState();
  const threadId = parsed.threadId!;
  const alreadyLoading = getSelectingThreadId() === threadId;
  const needsSelect =
    !alreadyLoading &&
    (threadId !== ts.selectedThreadId || !ts.activeThread || ts.activeThread.id !== threadId);
  if (needsSelect) ts.selectThread(threadId);
  if (parsed.projectId && parsed.projectId !== ps.selectedProjectId) {
    ps.selectProject(parsed.projectId);
  }
  syncPanelParam(search, ui);
  syncTabParam(search, ui);
}

function applyProjectRoute(parsed: ParsedRoute, search: string) {
  const ts = useThreadStore.getState();
  const ps = useProjectStore.getState();
  const ui = useUIStore.getState();
  if (ts.selectedThreadId) ts.selectThread(null);
  if (parsed.projectId !== ps.selectedProjectId) {
    ps.selectProject(parsed.projectId);
  }
  syncPanelParam(search, ui);
}

function applyRootRoute() {
  const ts = useThreadStore.getState();
  const ps = useProjectStore.getState();
  if (ts.selectedThreadId != null) ts.selectThread(null);
  if (ps.selectedProjectId != null) ps.selectProject(null);
}

function applyProjectOverlayRoute(parsed: ParsedRoute) {
  if (!parsed.projectId) return;
  const ps = useProjectStore.getState();
  if (parsed.projectId !== ps.selectedProjectId) {
    ps.selectProject(parsed.projectId);
  }
}

export function useThreadProjectSync(initialized: boolean, parsed: ParsedRoute) {
  const location = useLocation();

  useEffect(() => {
    if (!initialized) return;
    if (parsed.threadId) {
      applyThreadRoute(parsed, location.search);
      return;
    }
    if (parsed.externalClaudeSessionId) {
      applyRootRoute();
      return;
    }
    if (isOverlayActive(parsed)) {
      applyProjectOverlayRoute(parsed);
      return;
    }
    if (parsed.projectId) {
      applyProjectRoute(parsed, location.search);
      return;
    }
    applyRootRoute();
  }, [initialized, parsed, location.search]);
}
