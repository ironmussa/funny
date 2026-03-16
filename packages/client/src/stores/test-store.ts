import type {
  TestFile,
  TestFileStatus,
  TestSpec,
  WSTestStatusData,
  WSTestOutputData,
} from '@funny/shared';
import { create } from 'zustand';

import { api } from '@/lib/api';

interface OutputLine {
  line: string;
  stream: 'stdout' | 'stderr';
  timestamp: number;
}

interface TestState {
  files: TestFile[];
  isRunning: boolean;
  activeRunId: string | null;
  activeFile: string | null;
  activeProjectId: string | null;
  fileStatuses: Record<string, TestFileStatus>;
  outputLines: OutputLine[];
  isStreaming: boolean; // true when frames are arriving
  isLoading: boolean;

  /** Specs discovered within expanded files, keyed by file path */
  fileSpecs: Record<string, TestSpec[]>;
  /** Loading state for spec discovery, keyed by file path */
  specsLoading: Record<string, boolean>;

  // Actions
  loadFiles: (projectId: string) => Promise<void>;
  startRun: (projectId: string, file: string) => Promise<void>;
  startSpecRun: (projectId: string, file: string, line: number) => Promise<void>;
  stopRun: (projectId: string) => Promise<void>;
  discoverSpecs: (projectId: string, file: string) => Promise<void>;
  handleTestStatus: (data: WSTestStatusData) => void;
  handleTestOutput: (data: WSTestOutputData) => void;
  setStreaming: (streaming: boolean) => void;
  reset: () => void;
}

export const useTestStore = create<TestState>((set, get) => ({
  files: [],
  isRunning: false,
  activeRunId: null,
  activeFile: null,
  activeProjectId: null,
  fileStatuses: {},
  outputLines: [],
  isStreaming: false,
  isLoading: false,
  fileSpecs: {},
  specsLoading: {},

  loadFiles: async (projectId: string) => {
    set({ isLoading: true });
    const result = await api.listTestFiles(projectId);
    if (result.isOk()) {
      set({ files: result.value, activeProjectId: projectId, isLoading: false });
    } else {
      set({ files: [], isLoading: false });
    }
  },

  startRun: async (projectId: string, file: string) => {
    // Clear previous output
    set((s) => ({
      outputLines: [],
      isStreaming: false,
      fileStatuses: { ...s.fileStatuses, [file]: 'running' },
      activeFile: file,
      isRunning: true,
    }));

    const result = await api.runTest(projectId, file);
    if (result.isOk()) {
      set({ activeRunId: result.value.runId });
    } else {
      set((s) => ({
        isRunning: false,
        activeFile: null,
        fileStatuses: { ...s.fileStatuses, [file]: 'failed' },
      }));
    }
  },

  startSpecRun: async (projectId: string, file: string, line: number) => {
    set((s) => ({
      outputLines: [],
      isStreaming: false,
      fileStatuses: { ...s.fileStatuses, [file]: 'running' },
      activeFile: file,
      isRunning: true,
    }));

    const result = await api.runTest(projectId, file, line);
    if (result.isOk()) {
      set({ activeRunId: result.value.runId });
    } else {
      set((s) => ({
        isRunning: false,
        activeFile: null,
        fileStatuses: { ...s.fileStatuses, [file]: 'failed' },
      }));
    }
  },

  stopRun: async (projectId: string) => {
    await api.stopTest(projectId);
  },

  discoverSpecs: async (projectId: string, file: string) => {
    set((s) => ({
      specsLoading: { ...s.specsLoading, [file]: true },
    }));
    const result = await api.discoverTestSpecs(projectId, file);
    if (result.isOk()) {
      set((s) => ({
        fileSpecs: { ...s.fileSpecs, [file]: result.value.specs },
        specsLoading: { ...s.specsLoading, [file]: false },
      }));
    } else {
      // On error, set empty array so UI shows "No tests found" instead of nothing
      set((s) => ({
        fileSpecs: { ...s.fileSpecs, [file]: [] },
        specsLoading: { ...s.specsLoading, [file]: false },
      }));
    }
  },

  handleTestStatus: (data: WSTestStatusData) => {
    set((s) => {
      const updates: Partial<TestState> = {
        fileStatuses: { ...s.fileStatuses, [data.file]: data.status },
      };

      if (data.status === 'running') {
        updates.isRunning = true;
        updates.activeFile = data.file;
        updates.activeRunId = data.runId;
      } else if (
        data.status === 'passed' ||
        data.status === 'failed' ||
        data.status === 'stopped'
      ) {
        updates.isRunning = false;
        updates.isStreaming = false;
      }

      return updates;
    });
  },

  handleTestOutput: (data: WSTestOutputData) => {
    set((s) => ({
      outputLines: [
        ...s.outputLines,
        { line: data.line, stream: data.stream, timestamp: Date.now() },
      ],
    }));
  },

  setStreaming: (streaming: boolean) => set({ isStreaming: streaming }),

  reset: () =>
    set({
      files: [],
      isRunning: false,
      activeRunId: null,
      activeFile: null,
      activeProjectId: null,
      fileStatuses: {},
      outputLines: [],
      isStreaming: false,
      isLoading: false,
      fileSpecs: {},
      specsLoading: {},
    }),
}));
