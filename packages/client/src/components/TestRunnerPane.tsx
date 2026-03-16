import { PanelRightClose, Square } from 'lucide-react';
import { useCallback, useEffect } from 'react';

import { BrowserPreview } from '@/components/test-runner/BrowserPreview';
import { TestFileBrowser } from '@/components/test-runner/TestFileBrowser';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useProjectStore } from '@/stores/project-store';
import { useTestStore } from '@/stores/test-store';
import { useUIStore } from '@/stores/ui-store';

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

      {/* Two-section layout: file browser (top) and preview (bottom) */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* File browser — takes about 40% */}
        <div className="h-[40%] min-h-[150px] overflow-hidden border-b">
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

        {/* Browser preview + output log — takes remaining space */}
        <BrowserPreview isRunning={isRunning} isStreaming={isStreaming} outputLines={outputLines} />
      </div>
    </div>
  );
}
