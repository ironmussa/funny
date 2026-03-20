import { PanelRightClose, Square } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { BrowserPreview } from '@/components/test-runner/BrowserPreview';
import { TestFileBrowser } from '@/components/test-runner/TestFileBrowser';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useProjectStore } from '@/stores/project-store';
import { useTestStore } from '@/stores/test-store';
import { useUIStore } from '@/stores/ui-store';

const TEST_VIEWER_WIDTH_KEY = 'test_viewer_split';
const DEFAULT_SPLIT = 75; // percentage of container width for the left (viewer) column
const MIN_SPLIT = 30;
const MAX_SPLIT = 90;

export function TestRunnerPane() {
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const {
    files,
    isRunning,
    isLoading,
    fileStatuses,
    fileSpecs,
    specsLoading,
    outputLines,
    isStreaming,
    activeProjectId,
    loadFiles,
    startRun,
    startSpecRun,
    stopRun,
    discoverSpecs,
  } = useTestStore();

  // Load test files when the selected project changes
  useEffect(() => {
    if (selectedProjectId && selectedProjectId !== activeProjectId) {
      loadFiles(selectedProjectId);
    }
  }, [selectedProjectId, activeProjectId, loadFiles]);

  const handleRunFile = useCallback(
    (file: string) => {
      if (!selectedProjectId) return;
      startRun(selectedProjectId, file);
    },
    [selectedProjectId, startRun],
  );

  const handleRunSpec = useCallback(
    (file: string, line: number) => {
      if (!selectedProjectId) return;
      startSpecRun(selectedProjectId, file, line);
    },
    [selectedProjectId, startSpecRun],
  );

  const handleExpandFile = useCallback(
    (file: string) => {
      if (!selectedProjectId) return;
      if (!fileSpecs[file]) {
        discoverSpecs(selectedProjectId, file);
      }
    },
    [selectedProjectId, fileSpecs, discoverSpecs],
  );

  const handleRunAll = useCallback(() => {
    if (!selectedProjectId || files.length === 0) return;
    // Run the first file — sequential execution would need a queue
    startRun(selectedProjectId, files[0].path);
  }, [selectedProjectId, files, startRun]);

  const handleStop = useCallback(() => {
    if (!selectedProjectId) return;
    stopRun(selectedProjectId);
  }, [selectedProjectId, stopRun]);

  // --- Internal column resize ---
  const [splitPct, setSplitPct] = useState(() => {
    try {
      const stored = localStorage.getItem(TEST_VIEWER_WIDTH_KEY);
      return stored ? Number(stored) : DEFAULT_SPLIT;
    } catch {
      return DEFAULT_SPLIT;
    }
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [resizing, setResizing] = useState(false);

  const handleSplitPointerDown = useCallback((e: React.PointerEvent) => {
    dragging.current = true;
    setResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const handleSplitPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    const clamped = Math.max(MIN_SPLIT, Math.min(MAX_SPLIT, pct));
    setSplitPct(clamped);
    try {
      localStorage.setItem(TEST_VIEWER_WIDTH_KEY, String(clamped));
    } catch {}
  }, []);

  const handleSplitPointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    setResizing(false);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  }, []);

  if (!selectedProjectId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Select a project to run tests
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-sidebar-border px-4 py-3">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-sidebar-foreground">
            Test Runner
          </h3>
          {isRunning && (
            <Button
              data-testid="test-stop"
              variant="destructive"
              size="sm"
              className="h-5 gap-1 px-1.5 text-[10px]"
              onClick={handleStop}
            >
              <Square className="h-2.5 w-2.5" />
              Stop
            </Button>
          )}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => useUIStore.getState().setTestPaneOpen(false)}
              className="text-muted-foreground"
              data-testid="test-runner-close"
            >
              <PanelRightClose className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">Close</TooltipContent>
        </Tooltip>
      </div>

      {/* Two-column layout: browser preview (left) and file explorer (right) */}
      <div ref={containerRef} className="relative flex min-h-0 flex-1 overflow-hidden">
        {/* Left column — browser preview + test output */}
        <div className="min-w-0 overflow-hidden" style={{ width: `${splitPct}%` }}>
          <BrowserPreview
            isRunning={isRunning}
            isStreaming={isStreaming}
            outputLines={outputLines}
          />
        </div>

        {/* Resize handle */}
        <button
          aria-label="Resize test viewer"
          tabIndex={-1}
          onPointerDown={handleSplitPointerDown}
          onPointerMove={handleSplitPointerMove}
          onPointerUp={handleSplitPointerUp}
          className={`relative z-10 w-1.5 flex-shrink-0 cursor-col-resize border-x border-border bg-sidebar hover:bg-sidebar-accent ${!resizing ? 'transition-colors' : ''}`}
          data-testid="test-viewer-resize"
        />

        {/* Right column — test file explorer */}
        <div className="min-w-0 flex-1 overflow-hidden">
          <TestFileBrowser
            files={files}
            fileStatuses={fileStatuses}
            fileSpecs={fileSpecs}
            specsLoading={specsLoading}
            isRunning={isRunning}
            isLoading={isLoading}
            onRunFile={handleRunFile}
            onRunSpec={handleRunSpec}
            onExpandFile={handleExpandFile}
            onRunAll={handleRunAll}
          />
        </div>
      </div>
    </div>
  );
}
