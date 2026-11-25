import type {
  TestFile,
  TestFileStatus,
  TestNetworkEntry,
  TestSpec,
  TestSuite,
  WSTestActionData,
  WSTestConsoleData,
  WSTestErrorData,
  WSTestNetworkData,
  WSTestOutputData,
  WSTestStatusData,
} from '@funny/shared';
import { create } from 'zustand';

import { testsApi as api } from '@/lib/api/tests';

const STORAGE_KEY_PREFIX = 'test-selected-projects:';

function loadSelectedProjects(projectId: string): string[] | null {
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY_PREFIX}${projectId}`);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return null;
}

function saveSelectedProjects(projectId: string, selected: string[]) {
  try {
    localStorage.setItem(`${STORAGE_KEY_PREFIX}${projectId}`, JSON.stringify(selected));
  } catch {
    /* ignore */
  }
}

interface OutputLine {
  line: string;
  stream: 'stdout' | 'stderr';
  timestamp: number;
}

interface TestData {
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
  /** Suites (describe blocks) discovered within expanded files, keyed by file path */
  fileSuites: Record<string, TestSuite[]>;
  /** Loading state for spec discovery, keyed by file path */
  specsLoading: Record<string, boolean>;

  /** Playwright browser projects (e.g. ["chromium", "firefox", "webkit"]) */
  availableProjects: string[];
  /** Currently selected browser projects for running tests */
  selectedProjects: string[];

  /** Browser console messages captured via CDP */
  consoleEntries: WSTestConsoleData[];
  /** Network requests captured via CDP */
  networkEntries: TestNetworkEntry[];
  /** JavaScript errors captured via CDP */
  errorEntries: WSTestErrorData[];

  /** Structured Playwright actions from custom reporter */
  actions: WSTestActionData[];
  /** Index of the currently hovered action (-1 = none, live mode) */
  hoveredActionIndex: number;
  /** Index of the currently selected/clicked action (-1 = none) */
  selectedActionIndex: number;
  /** Frame history for action-frame correlation */
  frameHistory: Array<{ data: string; timestamp: number }>;
}

interface TestState extends TestData {
  loadFiles: (projectId: string) => Promise<void>;
  startRun: (projectId: string, file: string) => Promise<void>;
  startSpecRun: (projectId: string, file: string, line: number, project?: string) => Promise<void>;
  stopRun: (projectId: string) => Promise<void>;
  discoverSpecs: (projectId: string, file: string) => Promise<void>;
  toggleProject: (project: string) => void;
  handleTestStatus: (data: WSTestStatusData) => void;
  handleTestOutput: (data: WSTestOutputData) => void;
  handleTestConsole: (data: WSTestConsoleData) => void;
  handleTestNetwork: (data: WSTestNetworkData) => void;
  handleTestError: (data: WSTestErrorData) => void;
  handleTestAction: (data: WSTestActionData) => void;
  setHoveredActionIndex: (index: number) => void;
  setSelectedActionIndex: (index: number) => void;
  addFrameToHistory: (data: string, timestamp: number) => void;
  setStreaming: (streaming: boolean) => void;
  reset: () => void;
}

function initialTestData(): TestData {
  return {
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
    fileSuites: {},
    specsLoading: {},
    availableProjects: [],
    selectedProjects: [],
    consoleEntries: [],
    networkEntries: [],
    errorEntries: [],
    actions: [],
    hoveredActionIndex: -1,
    selectedActionIndex: -1,
    frameHistory: [],
  };
}

/** State for a run that starts on `file`: clears the previous output and debug data. */
function runStartState(s: TestState, file: string): Partial<TestState> {
  return {
    outputLines: [],
    consoleEntries: [],
    networkEntries: [],
    errorEntries: [],
    actions: [],
    hoveredActionIndex: -1,
    selectedActionIndex: -1,
    frameHistory: [],
    isStreaming: false,
    fileStatuses: { ...s.fileStatuses, [file]: 'running' },
    activeFile: file,
    isRunning: true,
  };
}

function runFailedState(s: TestState, file: string): Partial<TestState> {
  return {
    isRunning: false,
    activeFile: null,
    fileStatuses: { ...s.fileStatuses, [file]: 'failed' },
  };
}

/**
 * Update an existing network entry with response/completed/failure info.
 * Only overwrite fields that have actual values to avoid clobbering.
 */
function mergeNetworkEntry(e: TestNetworkEntry, update: TestNetworkEntry): TestNetworkEntry {
  const merged = { ...e };
  if (update.status != null) merged.status = update.status;
  if (update.statusText) merged.statusText = update.statusText;
  if (update.mimeType) merged.mimeType = update.mimeType;
  if (update.resourceType) merged.resourceType = update.resourceType;
  if (update.method) merged.method = update.method;
  if (update.url) merged.url = update.url;
  if (update.size != null) merged.size = update.size;
  if (update.failed) merged.failed = update.failed;
  if (update.errorText) merged.errorText = update.errorText;
  if (update.requestHeaders) merged.requestHeaders = update.requestHeaders;
  if (update.responseHeaders) merged.responseHeaders = update.responseHeaders;
  if (update.postData) merged.postData = update.postData;
  if (update.responseBody) merged.responseBody = update.responseBody;
  if (update.responseBodyBase64 != null) merged.responseBodyBase64 = update.responseBodyBase64;
  if (update.endTime) {
    merged.endTime = update.endTime;
    if (merged.startTime) merged.duration = update.endTime - merged.startTime;
  }
  return merged;
}

export const useTestStore = create<TestState>((set, get) => ({
  ...initialTestData(),

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
    set((s) => runStartState(s, file));

    const { selectedProjects } = get();
    const result = await api.runTest(projectId, file, undefined, selectedProjects);
    if (result.isOk()) {
      set({ activeRunId: result.value.runId });
    } else {
      set((s) => runFailedState(s, file));
    }
  },

  startSpecRun: async (projectId: string, file: string, line: number, project?: string) => {
    set((s) => runStartState(s, file));

    // If a specific browser project is given (e.g. clicking "chromium" under a spec), use it.
    // Otherwise use all selected projects.
    const { selectedProjects } = get();
    const projects = project ? [project] : selectedProjects;
    const result = await api.runTest(projectId, file, line, projects);
    if (result.isOk()) {
      set({ activeRunId: result.value.runId });
    } else {
      set((s) => runFailedState(s, file));
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
      const projects = result.value.projects ?? [];
      set((s) => {
        let projectUpdate: Partial<TestState> = {};
        if (s.availableProjects.length === 0 && projects.length > 0) {
          // Restore saved selection for this project, falling back to all
          const saved = s.activeProjectId ? loadSelectedProjects(s.activeProjectId) : null;
          const projectIds = new Set(projects);
          const validSaved = saved?.filter((project) => projectIds.has(project));
          projectUpdate = {
            availableProjects: projects,
            selectedProjects: validSaved && validSaved.length > 0 ? validSaved : projects,
          };
        }
        return {
          fileSpecs: { ...s.fileSpecs, [file]: result.value.specs },
          fileSuites: { ...s.fileSuites, [file]: result.value.suites ?? [] },
          specsLoading: { ...s.specsLoading, [file]: false },
          ...projectUpdate,
        };
      });
    } else {
      // On error, set empty array so UI shows "No tests found" instead of nothing
      set((s) => ({
        fileSpecs: { ...s.fileSpecs, [file]: [] },
        fileSuites: { ...s.fileSuites, [file]: [] },
        specsLoading: { ...s.specsLoading, [file]: false },
      }));
    }
  },

  toggleProject: (project: string) => {
    set((s) => {
      const isSelected = s.selectedProjects.includes(project);
      // Don't allow deselecting all — keep at least one
      if (isSelected && s.selectedProjects.length === 1) return s;
      const next = isSelected
        ? s.selectedProjects.filter((p) => p !== project)
        : [...s.selectedProjects, project];
      if (s.activeProjectId) saveSelectedProjects(s.activeProjectId, next);
      return { selectedProjects: next };
    });
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

  handleTestConsole: (data: WSTestConsoleData) => {
    set((s) => ({ consoleEntries: [...s.consoleEntries, data] }));
  },

  handleTestNetwork: (data: WSTestNetworkData) => {
    set((s) => {
      if (data.phase === 'request') {
        return { networkEntries: [...s.networkEntries, data.entry] };
      }
      // Update the existing entry with response/completed/failure info
      return {
        networkEntries: s.networkEntries.map((e) =>
          e.id === data.entry.id ? mergeNetworkEntry(e, data.entry) : e,
        ),
      };
    });
  },

  handleTestError: (data: WSTestErrorData) => {
    set((s) => ({ errorEntries: [...s.errorEntries, data] }));
  },

  handleTestAction: (data: WSTestActionData) => {
    set((s) => {
      if (data.endTime != null || data.duration != null) {
        // stepEnd — update the existing action by id
        return {
          actions: s.actions.map((a) =>
            a.id === data.id && !a.endTime
              ? { ...a, endTime: data.endTime, duration: data.duration, error: data.error }
              : a,
          ),
        };
      }
      // Check if this is a bounding box update (same id already exists)
      const existing = s.actions.find((a) => a.id === data.id);
      if (existing && data.boundingBox) {
        return {
          actions: s.actions.map((a) =>
            a.id === data.id ? { ...a, boundingBox: data.boundingBox } : a,
          ),
        };
      }
      // stepBegin — append new action
      return { actions: [...s.actions, data] };
    });
  },

  setHoveredActionIndex: (index: number) => set({ hoveredActionIndex: index }),
  setSelectedActionIndex: (index: number) => set({ selectedActionIndex: index }),

  addFrameToHistory: (data: string, timestamp: number) => {
    set((s) => {
      const MAX_CLIENT_FRAMES = 100;
      const next = [...s.frameHistory, { data, timestamp }];
      if (next.length > MAX_CLIENT_FRAMES) next.shift();
      return { frameHistory: next };
    });
  },

  setStreaming: (streaming: boolean) => set({ isStreaming: streaming }),

  reset: () => set(initialTestData()),
}));
