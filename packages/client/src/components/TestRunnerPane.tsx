import { PanelRightClose } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { BrowserPreview } from '@/components/test-runner/BrowserPreview';
import { TestFileBrowser } from '@/components/test-runner/TestFileBrowser';
import { Button } from '@/components/ui/button';
import { ResizeHandle, useResizeHandle } from '@/components/ui/resize-handle';
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
  const projectPath = useProjectStore(
    (s) => s.projects.find((p) => p.id === s.selectedProjectId)?.path,
  );
  const {
    files,
    isRunning,
    isLoading,
    fileStatuses,
    fileSpecs,
    fileSuites,
    specsLoading,
    outputLines,
    isStreaming,
    activeProjectId,
    activeFile,
    availableProjects,
    selectedProjects,
    consoleEntries,
    networkEntries,
    errorEntries,
    loadFiles,
    startRun,
    startSpecRun,
    stopRun,
    discoverSpecs,
    toggleProject,
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
    (file: string, line: number, project?: string) => {
      if (!selectedProjectId) return;
      startSpecRun(selectedProjectId, file, line, project);
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
  const startPct = useRef(splitPct);

  const { resizing, handlePointerDown, handlePointerMove, handlePointerUp } = useResizeHandle({
    direction: 'horizontal',
    onResizeStart: () => {
      startPct.current = splitPct;
    },
    onResize: (deltaPx) => {
      if (!containerRef.current) return;
      const width = containerRef.current.getBoundingClientRect().width;
      const deltaPct = (deltaPx / width) * 100;
      const clamped = Math.max(MIN_SPLIT, Math.min(MAX_SPLIT, startPct.current + deltaPct));
      setSplitPct(clamped);
      try {
        localStorage.setItem(TEST_VIEWER_WIDTH_KEY, String(clamped));
      } catch {}
    },
  });

  if (!selectedProjectId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Select a project to run tests
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-sidebar-border px-4 py-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-sidebar-foreground">
          Test Runner
        </h3>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => useUIStore.getState().setTestRunnerOpen(false)}
              className="text-muted-foreground"
              data-testid="test-runner-close"
            >
              <PanelRightClose className="icon-sm" />
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
            consoleEntries={consoleEntries}
            networkEntries={networkEntries}
            errorEntries={errorEntries}
            activeFile={activeFile}
            projectPath={projectPath}
            onStop={handleStop}
          />
        </div>

        {/* Resize handle */}
        <ResizeHandle
          direction="horizontal"
          resizing={resizing}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          data-testid="test-viewer-resize"
        />

        {/* Right column — test file explorer */}
        <div className="min-w-0 flex-1 overflow-hidden">
          <TestFileBrowser
            files={files}
            fileStatuses={fileStatuses}
            fileSpecs={fileSpecs}
            fileSuites={fileSuites}
            specsLoading={specsLoading}
            isRunning={isRunning}
            isLoading={isLoading}
            projectPath={projectPath}
            availableProjects={availableProjects}
            selectedProjects={selectedProjects}
            onToggleProject={toggleProject}
            onRunFile={handleRunFile}
            onRunSpec={handleRunSpec}
            onExpandFile={handleExpandFile}
            onRunAll={handleRunAll}
            onStop={handleStop}
          />
        </div>
      </div>
    </div>
  );
}
