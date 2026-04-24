// ─── Test Runner ─────────────────────────────────────────

export interface TestFile {
  path: string; // relative to project root, e.g. "e2e/app.spec.ts"
}

export interface TestSpec {
  id: string; // Playwright spec id or "file:line" fallback
  title: string; // e.g. "A.1 Sidebar navigation icons have accessible labels"
  file: string; // relative path
  line: number;
  column: number;
  projects: string[]; // Playwright projects this spec runs in (e.g. ["chromium", "firefox"])
}

export interface TestSuite {
  title: string; // e.g. "Logger - Crear logs con metadata"
  file: string;
  line: number;
  column: number;
  specs: TestSpec[];
  suites: TestSuite[]; // nested describe blocks
}

export interface DiscoverTestsResponse {
  file: string;
  specs: TestSpec[]; // flat list (backwards compat)
  suites: TestSuite[]; // hierarchical structure with describe blocks
  projects: string[]; // Playwright projects (e.g. ["chromium", "firefox", "webkit"])
}

export interface RunTestRequest {
  file: string; // relative path of the test file to run
  line?: number; // when set, runs only the test at this line
  projects?: string[]; // Playwright projects to run (e.g. ["chromium"])
}

export interface RunTestResponse {
  runId: string;
}

export type TestFileStatus = 'idle' | 'running' | 'passed' | 'failed' | 'stopped';

// ─── Test Action Types (Playwright reporter structured actions) ─────

export type TestActionCategory = 'pw:api' | 'expect' | 'fixture' | 'hook' | 'test.step';

export interface TestActionBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WSTestActionData {
  /** Unique action id, e.g. "step-0" */
  id: string;
  /** Human-readable action title, e.g. "page.click('button.submit')" */
  title: string;
  /** Playwright step category */
  category: TestActionCategory;
  /** CSS selector extracted from the action title (if applicable) */
  selector?: string;
  /** Epoch ms when this step started */
  startTime: number;
  /** Epoch ms when this step ended (set on stepEnd) */
  endTime?: number;
  /** Duration in ms */
  duration?: number;
  /** Error message if step failed */
  error?: string;
  /** Parent step id for nested steps */
  parentId?: string;
  /** Element bounding box at action time (resolved via CDP) */
  boundingBox?: TestActionBoundingBox;
  /** Timestamp of the nearest captured frame */
  frameTimestamp?: number;
}

// ─── Test WebSocket Event Data ──────────────────────────────────────

export interface WSTestFrameData {
  data: string; // base64 JPEG
  timestamp: number;
}

export interface WSTestOutputData {
  line: string;
  stream: 'stdout' | 'stderr';
}

export interface WSTestStatusData {
  status: TestFileStatus;
  file: string;
  runId: string;
  exitCode?: number;
  error?: string;
}

export type TestConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug' | 'trace';

export interface WSTestConsoleData {
  level: TestConsoleLevel;
  text: string;
  url?: string;
  line?: number;
  column?: number;
  timestamp: number;
}

export interface TestNetworkEntry {
  id: string;
  method: string;
  url: string;
  status?: number;
  statusText?: string;
  resourceType?: string;
  mimeType?: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  size?: number;
  failed?: boolean;
  errorText?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  postData?: string;
  responseBody?: string;
  responseBodyBase64?: boolean;
}

export interface WSTestNetworkData {
  entry: TestNetworkEntry;
  phase: 'request' | 'response' | 'completed' | 'failed';
}

export interface WSTestErrorData {
  message: string;
  source?: string;
  line?: number;
  column?: number;
  stack?: string;
  timestamp: number;
}
