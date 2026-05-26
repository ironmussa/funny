import { PanelBottomClose, PictureInPicture2, Plus } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';

import { isTauri } from '@/components/terminal/xterm-utils';
import {
  CommandTabContent,
  TauriTerminalTabContent,
  TerminalSearchOverlay,
  WebTerminalTabContent,
} from '@/components/TerminalPanel';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTerminalScope } from '@/hooks/use-terminal-scope';
import { useTooltipMenu } from '@/hooks/use-tooltip-menu';
import { getActiveWS } from '@/hooks/use-ws';
import { useProjectStore } from '@/stores/project-store';
import { type TerminalShell, useSettingsStore } from '@/stores/settings-store';
import {
  SCRATCH_TERMINAL_SCOPE_ID,
  useTerminalStore,
  type TerminalTab,
} from '@/stores/terminal-store';
import { useThreadWorktreePath } from '@/stores/thread-context';

import { type BottomTabSpec } from '../DockviewLayout';

/** Render the appropriate body for a single terminal tab (Web PTY, Tauri PTY,
 *  command output, or an empty fallback). Always rendered as the dockview
 *  panel content — never unmounted on tab switch because we use
 *  `renderer: 'always'` on the dockview side.
 *
 *  We force `active=true` to the inner terminal components because, inside
 *  dockview, each panel has its own host div and dockview itself hides the
 *  inactive tabs in a group via CSS. The legacy `active ? z-10 : invisible`
 *  styling used by these components was designed for the old `TerminalPanel`
 *  where all tabs overlap in a single container — when applied inside dockview
 *  it hides a split terminal that is actually visible in its own group. The
 *  `active` prop here is still used to scope the Ctrl+F search overlay to the
 *  store's single active tab so a key press doesn't open N overlays. */
function TerminalTabBody({ tab, active }: { tab: TerminalTab; active: boolean }) {
  const panelVisibleByProject = useTerminalStore((s) => s.panelVisibleByProject);
  const panelVisible = tab.projectId ? (panelVisibleByProject[tab.projectId] ?? true) : true;

  const [searchVisible, setSearchVisible] = useState(false);

  // The xterm tab forwards Ctrl+F via a window event. We scope it to the
  // currently-active tab so multiple panels mounted at once don't all open.
  useMemo(() => {
    if (!active) return;
    const handler = () => setSearchVisible(true);
    window.addEventListener('terminal:search-open', handler);
    return () => window.removeEventListener('terminal:search-open', handler);
  }, [active]);

  return (
    <div className="relative h-full w-full bg-background">
      {searchVisible && active && (
        <TerminalSearchOverlay activeTabId={tab.id} onClose={() => setSearchVisible(false)} />
      )}
      {tab.type === 'pty' ? (
        <WebTerminalTabContent
          id={tab.id}
          cwd={tab.cwd}
          active={true}
          panelVisible={panelVisible}
          shell={tab.shell}
          restored={tab.restored}
          projectId={tab.projectId}
          label={tab.label}
          initialCommand={tab.initialCommand}
          scratchThreadId={tab.scratchThreadId}
        />
      ) : tab.commandId ? (
        <CommandTabContent
          commandId={tab.commandId}
          projectId={tab.projectId}
          active={true}
          alive={tab.alive}
        />
      ) : isTauri ? (
        <TauriTerminalTabContent id={tab.id} cwd={tab.cwd} active={true} />
      ) : (
        <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
          (unknown terminal type)
        </div>
      )}
    </div>
  );
}

/** "+ new terminal" dropdown — rendered in the bottom group's prefix header. */
function NewTerminalButton() {
  const { t } = useTranslation();
  const menu = useTooltipMenu();
  const availableShells = useSettingsStore((s) => s.availableShells);
  const fetchAvailableShells = useSettingsStore((s) => s.fetchAvailableShells);
  const addTab = useTerminalStore((s) => s.addTab);
  const togglePanel = useTerminalStore((s) => s.togglePanel);
  const projects = useProjectStore((s) => s.projects);
  const { scopeId: selectedProjectId, scratchThreadId } = useTerminalScope();
  const activeThreadWorktreePath = useThreadWorktreePath();
  const visibleTabs = useTerminalStore(
    useShallow((s) => s.tabs.filter((tab) => tab.projectId === selectedProjectId)),
  );

  const handleCreate = useCallback(
    (shell: TerminalShell) => {
      if (!selectedProjectId) return;
      const isScratchScope = selectedProjectId === SCRATCH_TERMINAL_SCOPE_ID;
      const project = isScratchScope ? null : projects.find((p) => p.id === selectedProjectId);
      const cwd = isScratchScope ? '~' : activeThreadWorktreePath || project?.path || 'C:\\';
      const detected = availableShells.find((s) => s.id === shell);
      const shellName = detected?.label ?? 'Terminal';
      const sameShellCount = visibleTabs.filter((tab) => (tab.shell ?? 'default') === shell).length;
      const label = `${shellName} ${sameShellCount + 1}`;
      addTab({
        id: crypto.randomUUID(),
        label,
        cwd,
        alive: true,
        projectId: selectedProjectId,
        type: isTauri ? undefined : 'pty',
        shell,
        createdAt: Date.now(),
        scratchThreadId: isScratchScope ? (scratchThreadId ?? undefined) : undefined,
      });
      const current = useTerminalStore.getState();
      if (!current.panelVisibleByProject[selectedProjectId]) {
        togglePanel(selectedProjectId);
      }
    },
    [
      selectedProjectId,
      scratchThreadId,
      projects,
      activeThreadWorktreePath,
      availableShells,
      visibleTabs,
      addTab,
      togglePanel,
    ],
  );

  // Compose the tooltip-menu's onOpenChange with a lazy shell-list load so we
  // only fetch the shells the first time the menu opens.
  const onOpenChange = useCallback(
    (open: boolean) => {
      menu.menuProps.onOpenChange(open);
      if (open && availableShells.length === 0) fetchAvailableShells();
    },
    [menu.menuProps, availableShells.length, fetchAvailableShells],
  );

  if (!selectedProjectId) return null;

  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <Tooltip {...menu.tooltipProps}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              data-testid="terminal-new"
              className="h-full rounded-none px-2.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              <Plus className="icon-sm" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{t('terminal.newTerminal', 'New terminal')}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" side="bottom" {...menu.contentProps}>
        {availableShells.length === 0 ? (
          <DropdownMenuItem onClick={() => handleCreate('default')}>
            {t('settings.shellDefault', 'Default shell')}
          </DropdownMenuItem>
        ) : (
          availableShells.map((shell) => (
            <DropdownMenuItem
              key={shell.id}
              onClick={() => handleCreate(shell.id)}
              data-testid={`terminal-new-${shell.id}`}
            >
              {shell.label}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** "Detach" button — pops the active terminal out into a real OS browser
 *  window (and re-docks it back into the bottom group on a second click).
 *  Dispatches a window event that DockviewLayout listens for, so this
 *  component doesn't need a dockview-API ref. */
function DetachTerminalButton({ activeTabId }: { activeTabId: string | undefined }) {
  const { t } = useTranslation();
  if (!activeTabId) return null;
  const onClick = () => {
    window.dispatchEvent(
      new CustomEvent('dockview:popout-bottom', { detail: { tabId: activeTabId } }),
    );
  };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          onClick={onClick}
          data-testid="terminal-detach"
          className="h-full rounded-none px-2.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <PictureInPicture2 className="icon-sm" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {t('terminal.detach', 'Open terminal in a new window / re-dock')}
      </TooltipContent>
    </Tooltip>
  );
}

/** "Hide" button — collapses the whole bottom terminal panel for the current
 *  project scope. The panel can be restored from the sidebar / status bar. */
function HideTerminalPanelButton() {
  const { t } = useTranslation();
  const { scopeId: selectedProjectId } = useTerminalScope();
  const togglePanel = useTerminalStore((s) => s.togglePanel);
  if (!selectedProjectId) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          onClick={() => togglePanel(selectedProjectId)}
          data-testid="terminal-hide-panel"
          className="h-full rounded-none px-2.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <PanelBottomClose className="icon-sm" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t('terminal.hidePanel', 'Hide terminal panel')}</TooltipContent>
    </Tooltip>
  );
}

/** Hook that derives all the props DockviewLayout needs to render the bottom
 *  group as a set of native dockview tabs (one per terminal). */
export function useTerminalDockview(): {
  bottomTabs: BottomTabSpec[];
  activeBottomTab: string | undefined;
  onActiveBottomTabChange: (id: string) => void;
  onBottomTabClose: (id: string) => void;
  onBottomTabsReorder: (orderedIds: string[]) => void;
  bottomPaneOpen: boolean;
  bottomPrefixActions: React.ReactNode;
  bottomLeftActions: React.ReactNode;
  bottomRightActions: React.ReactNode;
} {
  const { scopeId: selectedProjectId } = useTerminalScope();
  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const panelVisibleByProject = useTerminalStore((s) => s.panelVisibleByProject);
  const setActiveTab = useTerminalStore((s) => s.setActiveTab);
  const removeTab = useTerminalStore((s) => s.removeTab);
  const reorderTabs = useTerminalStore((s) => s.reorderTabs);

  const visibleTabs = useMemo(
    () => tabs.filter((tab) => tab.projectId === selectedProjectId),
    [tabs, selectedProjectId],
  );

  const bottomTabs = useMemo<BottomTabSpec[]>(
    () =>
      visibleTabs.map((tab) => ({
        id: tab.id,
        title: tab.label,
        content: <TerminalTabBody tab={tab} active={tab.id === activeTabId} />,
      })),
    [visibleTabs, activeTabId],
  );

  const effectiveActiveTabId = useMemo(() => {
    if (activeTabId && visibleTabs.some((tab) => tab.id === activeTabId)) {
      return activeTabId;
    }
    return visibleTabs[visibleTabs.length - 1]?.id;
  }, [activeTabId, visibleTabs]);

  const onActiveBottomTabChange = useCallback((id: string) => setActiveTab(id), [setActiveTab]);

  const onBottomTabClose = useCallback(
    (id: string) => {
      const tab = tabs.find((t) => t.id === id);
      if (tab?.type === 'pty') {
        const ws = getActiveWS();
        if (ws && ws.connected) ws.emit('pty:kill', { id });
      }
      removeTab(id);
    },
    [tabs, removeTab],
  );

  const onBottomTabsReorder = useCallback(
    (orderedIds: string[]) => {
      if (!selectedProjectId) return;
      const current = visibleTabs.map((t) => t.id);
      // Find the first index where the order differs; translate into the
      // (startIndex, finishIndex) shape that the store's reorderTabs expects.
      for (let i = 0; i < orderedIds.length; i++) {
        if (orderedIds[i] !== current[i]) {
          const movedId = orderedIds[i];
          const startIndex = current.indexOf(movedId);
          if (startIndex !== -1 && startIndex !== i) {
            reorderTabs(selectedProjectId, startIndex, i);
          }
          break;
        }
      }
    },
    [selectedProjectId, visibleTabs, reorderTabs],
  );

  const bottomPaneOpen = selectedProjectId
    ? (panelVisibleByProject[selectedProjectId] ?? false) && visibleTabs.length > 0
    : false;

  return {
    bottomTabs,
    activeBottomTab: effectiveActiveTabId,
    onActiveBottomTabChange,
    onBottomTabClose,
    onBottomTabsReorder,
    bottomPaneOpen,
    bottomPrefixActions: null,
    bottomLeftActions: <NewTerminalButton />,
    bottomRightActions: (
      <>
        <DetachTerminalButton activeTabId={effectiveActiveTabId} />
        <HideTerminalPanelButton />
      </>
    ),
  };
}
