import { X, RefreshCw, ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';

import { cn } from '@/lib/utils';

interface PreviewTab {
  commandId: string;
  projectId: string;
  port: number;
  label: string;
}

const isTauri = !!(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__;

export function PreviewBrowser() {
  const [tabs, setTabs] = useState<PreviewTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [iframeKey, setIframeKey] = useState(0);

  const activeTab = tabs.find((t) => t.commandId === activeTabId);

  // Listen for Tauri events from the main window
  useEffect(() => {
    if (!isTauri) return;

    const unlisteners: Array<() => void> = [];

    (async () => {
      const { listen, emit } = await import('@tauri-apps/api/event');

      const u1 = await listen<PreviewTab>('preview:add-tab', (e) => {
        const tab = e.payload;
        setTabs((prev) => {
          if (prev.some((t) => t.commandId === tab.commandId)) return prev;
          return [...prev, tab];
        });
        setActiveTabId(tab.commandId);
      });
      unlisteners.push(u1);

      const u2 = await listen<{ commandId: string }>('preview:remove-tab', (e) => {
        const { commandId } = e.payload;
        setTabs((prev) => {
          const remaining = prev.filter((t) => t.commandId !== commandId);
          return remaining;
        });
        setActiveTabId((prev) => {
          if (prev === commandId) {
            // Switch to last remaining tab using the setter's callback for fresh state
            return null; // Will be corrected by the sync effect below
          }
          return prev;
        });
      });
      unlisteners.push(u2);

      const u3 = await listen<{ commandId: string }>('preview:focus-tab', (e) => {
        setActiveTabId(e.payload.commandId);
      });
      unlisteners.push(u3);

      const u4 = await listen<{ commandId: string }>('preview:refresh-tab', (_e) => {
        // Refresh any matching tab (use setter to avoid stale closure)
        setIframeKey((k) => k + 1);
      });
      unlisteners.push(u4);

      // Tell the main window we're ready to receive tabs
      await emit('preview:ready', {});
    })();

    return () => {
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  // Update active tab reference when tabs change
  useEffect(() => {
    if (activeTabId && !tabs.some((t) => t.commandId === activeTabId)) {
      setActiveTabId(tabs[tabs.length - 1]?.commandId ?? null);
    }
  }, [tabs, activeTabId]);

  const handleRefresh = () => setIframeKey((k) => k + 1);

  const handleCloseTab = async (commandId: string) => {
    setTabs((prev) => prev.filter((t) => t.commandId !== commandId));
    if (activeTabId === commandId) {
      const remaining = tabs.filter((t) => t.commandId !== commandId);
      setActiveTabId(remaining[remaining.length - 1]?.commandId ?? null);
    }
    // Notify main window
    if (isTauri) {
      const { emit } = await import('@tauri-apps/api/event');
      emit('preview:tab-closed', { commandId });
    }
  };

  const handleOpenExternal = () => {
    if (activeTab) {
      window.open(`http://localhost:${activeTab.port}`, '_blank');
    }
  };

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* Tab bar */}
      <div className="flex min-h-[36px] items-center border-b border-border bg-muted/30">
        <div className="flex flex-1 items-center overflow-x-auto">
          {tabs.map((tab) => (
            <div
              key={tab.commandId}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer border-r border-border min-w-0 max-w-[200px] group',
                tab.commandId === activeTabId
                  ? 'bg-background text-foreground'
                  : 'text-muted-foreground hover:bg-accent/50',
              )}
              onClick={() => setActiveTabId(tab.commandId)}
            >
              <span className="truncate">{tab.label}</span>
              <span className="flex-shrink-0 text-xs text-muted-foreground/60">:{tab.port}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleCloseTab(tab.commandId);
                }}
                className="ml-auto flex-shrink-0 opacity-0 transition-opacity hover:text-status-error group-hover:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>

        {/* Actions */}
        {activeTab && (
          <div className="flex flex-shrink-0 items-center gap-1 px-2">
            <span className="mr-1 font-mono text-xs text-muted-foreground">
              localhost:{activeTab.port}
            </span>
            <button
              onClick={handleRefresh}
              className="rounded p-1 text-muted-foreground hover:text-foreground"
              title="Refresh"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={handleOpenExternal}
              className="rounded p-1 text-muted-foreground hover:text-foreground"
              title="Open in browser"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* Content */}
      <div className="relative flex-1">
        {activeTab ? (
          <iframe
            key={`${activeTab.commandId}-${iframeKey}`}
            src={`http://localhost:${activeTab.port}`}
            className="h-full w-full border-0"
            title={`Preview: ${activeTab.label}`}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            No previews open. Start a command with a port to see it here.
          </div>
        )}
      </div>
    </div>
  );
}
