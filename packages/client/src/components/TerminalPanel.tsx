import { Plus, X } from 'lucide-react';
import { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';

import { DraggableTerminalTab } from '@/components/terminal/DraggableTerminalTab';
import { TerminalSearchOverlay } from '@/components/terminal/TerminalSearchOverlay';
import { TerminalSignalMenu } from '@/components/terminal/TerminalSignalMenu';
import { TerminalTabContent } from '@/components/terminal/TerminalTabContent';
import { useTerminalTabReorder } from '@/components/terminal/use-terminal-tab-reorder';
import { searchAddonRegistry, terminalRegistry } from '@/components/terminal/xterm-utils';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { ResizeHandle, useResizeHandle } from '@/components/ui/resize-handle';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useResettableState } from '@/hooks/use-resettable-state';
import { useTerminalScope } from '@/hooks/use-terminal-scope';
import { useTooltipMenu } from '@/hooks/use-tooltip-menu';
import { sendTerminalRealtime } from '@/hooks/use-ws';
import { openScopeTerminal } from '@/lib/open-terminal-tab';
import { cn } from '@/lib/utils';
import { type TerminalShell, useSettingsStore } from '@/stores/settings-store';
import { useTerminalStore } from '@/stores/terminal-store';

// The tab contents live in components/terminal/. They are re-exported here
// because TerminalDockview lazy-loads them from this module.
export { CommandTabContent } from '@/components/terminal/CommandTabContent';
export { JobLogTabContent } from '@/components/terminal/JobLogTabContent';
export { TauriTerminalTabContent } from '@/components/terminal/TauriTerminalTabContent';
export { TerminalSearchOverlay } from '@/components/terminal/TerminalSearchOverlay';
export { WebTerminalTabContent } from '@/components/terminal/WebTerminalTabContent';

const PANEL_HEIGHT = 300;

export function TerminalPanel() {
  const { t } = useTranslation();
  const {
    tabs,
    activeTabId,
    panelVisibleByProject,
    sessionsChecked,
    removeTab,
    reorderTabs,
    renameTab,
    setActiveTab,
    togglePanel,
  } = useTerminalStore(
    useShallow((s) => ({
      tabs: s.tabs,
      activeTabId: s.activeTabId,
      panelVisibleByProject: s.panelVisibleByProject,
      sessionsChecked: s.sessionsChecked,
      removeTab: s.removeTab,
      reorderTabs: s.reorderTabs,
      renameTab: s.renameTab,
      setActiveTab: s.setActiveTab,
      togglePanel: s.togglePanel,
    })),
  );
  const terminalScope = useTerminalScope();
  const selectedProjectId = terminalScope.scopeId;
  const panelVisible = selectedProjectId
    ? (panelVisibleByProject[selectedProjectId] ?? false)
    : false;
  const availableShells = useSettingsStore((s) => s.availableShells);
  const fetchAvailableShells = useSettingsStore((s) => s.fetchAvailableShells);

  useEffect(() => {
    fetchAvailableShells();
  }, [fetchAvailableShells]);

  const [panelHeight, setPanelHeight] = useState(PANEL_HEIGHT);
  const newTermMenu = useTooltipMenu();
  const startHeight = useRef(panelHeight);

  const {
    resizing: dragging,
    handlePointerDown: handleDragPointerDown,
    handlePointerMove: handleDragPointerMove,
    handlePointerUp: handleDragPointerUp,
  } = useResizeHandle({
    direction: 'vertical',
    onResizeStart: () => {
      startHeight.current = panelHeight;
    },
    onResize: (deltaPx) => {
      // Dragging up (negative delta) increases height
      setPanelHeight(Math.max(150, Math.min(startHeight.current - deltaPx, 600)));
    },
  });

  const visibleTabs = useMemo(
    () => tabs.filter((t) => t.projectId === selectedProjectId),
    [tabs, selectedProjectId],
  );

  const effectiveActiveTabId = useMemo(() => {
    if (activeTabId && visibleTabs.some((t) => t.id === activeTabId)) {
      return activeTabId;
    }
    return visibleTabs[visibleTabs.length - 1]?.id ?? null;
  }, [activeTabId, visibleTabs]);

  // Search closes when the active tab changes.
  const [searchVisible, setSearchVisible] = useResettableState(false, [effectiveActiveTabId]);

  const handleNewTerminal = useCallback(
    (shell: TerminalShell) => {
      if (terminalScope.scopeId)
        openScopeTerminal({ ...terminalScope, scopeId: terminalScope.scopeId }, shell);
    },
    [terminalScope],
  );

  // Open the search overlay when a terminal forwards Ctrl+F via custom event
  useEffect(() => {
    const handler = () => setSearchVisible(true);
    window.addEventListener('terminal:search-open', handler);
    return () => window.removeEventListener('terminal:search-open', handler);
  }, [setSearchVisible]);

  const closeSearch = useCallback(() => {
    setSearchVisible(false);
    if (effectiveActiveTabId) {
      const addon = searchAddonRegistry.get(effectiveActiveTabId);
      addon?.clearDecorations();
      terminalRegistry.get(effectiveActiveTabId)?.focus();
    }
  }, [effectiveActiveTabId, setSearchVisible]);

  useTerminalTabReorder(selectedProjectId, reorderTabs);

  const handleCloseTab = useCallback(
    (tabId: string) => {
      const tab = tabs.find((t) => t.id === tabId);
      // Send pty:kill for interactive PTY tabs (user explicitly closing)
      if (tab?.type === 'pty') {
        sendTerminalRealtime(tabId, { case: 'close', reason: 'tab-closed' });
      }
      removeTab(tabId);
    },
    [tabs, removeTab],
  );

  const handleKillTab = useCallback(
    (tabId: string) => {
      const tab = tabs.find((t) => t.id === tabId);
      if (tab?.type !== 'pty') return;
      sendTerminalRealtime(tabId, { case: 'signal', signal: 'SIGKILL' });
    },
    [tabs],
  );

  return (
    <div
      className={cn(
        'h-[var(--terminal-panel-visible-height)] shrink-0 overflow-hidden',
        !dragging && 'transition-[height] duration-200 ease-in-out',
      )}
      style={{
        '--terminal-panel-visible-height': panelVisible ? `${panelHeight}px` : '0px',
        '--terminal-panel-height': `${panelHeight}px`,
      }}
    >
      {/* Inner wrapper always keeps full height so xterm terminals preserve their buffer */}
      <div className="bg-background flex h-[var(--terminal-panel-height)] flex-col">
        {/* Drag handle — matches sidebar rail style */}
        <ResizeHandle
          direction="vertical"
          resizing={dragging}
          onPointerDown={handleDragPointerDown}
          onPointerMove={handleDragPointerMove}
          onPointerUp={handleDragPointerUp}
        />

        {/* Tab bar */}
        <div className="bg-background flex h-8 shrink-0 items-center gap-0.5 px-2">
          <div className="flex flex-1 items-center gap-0.5 overflow-x-auto">
            {visibleTabs.map((tab, index) => (
              <DraggableTerminalTab
                key={tab.id}
                tab={tab}
                index={index}
                active={effectiveActiveTabId === tab.id}
                sessionsChecked={sessionsChecked}
                onActivate={() => {
                  setActiveTab(tab.id);
                  if (!panelVisible && selectedProjectId) togglePanel(selectedProjectId);
                }}
                onClose={() => handleCloseTab(tab.id)}
                onKill={() => handleKillTab(tab.id)}
                onRename={(label) => renameTab(tab.id, label)}
              />
            ))}
          </div>

          <DropdownMenu {...newTermMenu.menuProps}>
            <Tooltip {...newTermMenu.tooltipProps}>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-xs">
                    <Plus className="icon-sm" />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>{t('terminal.newTerminal')}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="start" side="top" {...newTermMenu.contentProps}>
              {availableShells.map((shell) => (
                <DropdownMenuItem
                  key={shell.id}
                  onClick={() => handleNewTerminal(shell.id)}
                  data-testid={`terminal-new-${shell.id}`}
                >
                  {shell.label}
                </DropdownMenuItem>
              ))}
              {availableShells.length === 0 && (
                <DropdownMenuItem onClick={() => handleNewTerminal('default')}>
                  {t('settings.shellDefault')}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {effectiveActiveTabId &&
            visibleTabs.find((t) => t.id === effectiveActiveTabId)?.alive &&
            visibleTabs.find((t) => t.id === effectiveActiveTabId)?.type === 'pty' && (
              <TerminalSignalMenu ptyId={effectiveActiveTabId} />
            )}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                className="ml-auto"
                onClick={() => selectedProjectId && togglePanel(selectedProjectId)}
              >
                <X className="icon-sm" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('terminal.hideTerminal')}</TooltipContent>
          </Tooltip>
        </div>

        {/* Terminal content area */}
        <div className="bg-background relative m-2 min-h-0 flex-1 overflow-hidden">
          {searchVisible && effectiveActiveTabId && (
            <TerminalSearchOverlay activeTabId={effectiveActiveTabId} onClose={closeSearch} />
          )}
          {visibleTabs.length === 0 ? (
            <EmptyState title={t('terminal.noProcesses')} />
          ) : (
            visibleTabs.map((tab) => (
              <TerminalTabContent
                key={tab.id}
                tab={tab}
                active={tab.id === effectiveActiveTabId}
                panelVisible={panelVisible}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
