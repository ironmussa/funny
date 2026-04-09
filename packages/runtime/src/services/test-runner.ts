import { randomUUID } from 'crypto';
import { readdir, writeFile, unlink } from 'fs/promises';
import { join, relative } from 'path';

import type {
  TestFileStatus,
  TestSpec,
  TestSuite,
  WSTestActionData,
  TestActionBoundingBox,
} from '@funny/shared';

import { log } from '../lib/logger.js';
import { wsBroker } from './ws-broker.js';

// ─── Types ──────────────────────────────────────────────

interface FrameSnapshot {
  data: string; // base64 JPEG
  timestamp: number;
}

interface ActiveRun {
  runId: string;
  file: string;
  projectId: string;
  userId: string;
  process: ReturnType<typeof Bun.spawn> | null;
  chromeSession: any | null; // ChromeSession from podman-chrome-streaming
  startedAt: number;
  /** Ring buffer of recent frames for action-frame correlation */
  frameBuffer: FrameSnapshot[];
  /** Step counter for generating action IDs */
  stepCounter: number;
}

/** Max time (ms) a run can stay in activeRuns before being considered stale. */
const STALE_RUN_TIMEOUT = 5 * 60 * 1000; // 5 minutes

// One active run per project
const activeRuns = new Map<string, ActiveRun>();

const CDP_PORT = 9223;

// ─── Test File Discovery ────────────────────────────────

async function walkDir(dir: string, root: string, pattern: RegExp): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip node_modules, .git, dist, etc.
        if (
          entry.name === 'node_modules' ||
          entry.name === '.git' ||
          entry.name === 'dist' ||
          entry.name === '.funny-worktrees'
        ) {
          continue;
        }
        results.push(...(await walkDir(fullPath, root, pattern)));
      } else if (pattern.test(entry.name)) {
        results.push(relative(root, fullPath));
      }
    }
  } catch {
    // Directory doesn't exist or not readable
  }
  return results;
}

export async function discoverTestFiles(projectPath: string): Promise<string[]> {
  const files = await walkDir(projectPath, projectPath, /\.spec\.(ts|tsx|js|jsx)$/);
  return files.sort();
}

// ─── Test Spec Discovery ─────────────────────────────────

/** Extract project names from a Playwright spec's tests array */
function getSpecProjects(spec: any): string[] {
  return (spec.tests ?? []).map((t: any) => t.projectName).filter(Boolean);
}

/**
 * Deduplicate specs that appear multiple times (once per Playwright project).
 * Merges project names into a single spec entry keyed by file:line.
 */
function dedupeSpecs(rawSpecs: TestSpec[]): TestSpec[] {
  const map = new Map<string, TestSpec>();
  for (const spec of rawSpecs) {
    const key = `${spec.file}:${spec.line}`;
    const existing = map.get(key);
    if (existing) {
      // Merge projects
      for (const p of spec.projects) {
        if (!existing.projects.includes(p)) existing.projects.push(p);
      }
    } else {
      map.set(key, { ...spec });
    }
  }
  return Array.from(map.values());
}

function walkSuitesFlat(suites: any[], file: string): TestSpec[] {
  const specs: TestSpec[] = [];
  for (const suite of suites) {
    if (suite.specs) {
      for (const spec of suite.specs) {
        specs.push({
          id: spec.id ?? `${file}:${spec.line}`,
          title: spec.title,
          file: spec.file ?? file,
          line: spec.line,
          column: spec.column,
          projects: getSpecProjects(spec),
        });
      }
    }
    if (suite.suites) {
      specs.push(...walkSuitesFlat(suite.suites, file));
    }
  }
  return dedupeSpecs(specs);
}

function walkSuitesTree(suites: any[], file: string): TestSuite[] {
  const result: TestSuite[] = [];
  for (const suite of suites) {
    const rawSpecs: TestSpec[] = [];
    if (suite.specs) {
      for (const spec of suite.specs) {
        rawSpecs.push({
          id: spec.id ?? `${file}:${spec.line}`,
          title: spec.title,
          file: spec.file ?? file,
          line: spec.line,
          column: spec.column,
          projects: getSpecProjects(spec),
        });
      }
    }
    const specs = dedupeSpecs(rawSpecs);
    const childSuites = suite.suites ? walkSuitesTree(suite.suites, file) : [];

    // Skip the root file-level suite (title matches filename, line 0) — hoist its children
    // Playwright uses just the basename (e.g. "logger-logs.spec.ts") while file may be a relative path (e.g. "e2e/logger-logs.spec.ts")
    const basename = file.includes('/') ? file.split('/').pop() : file;
    const isRootFileSuite =
      suite.line === 0 && suite.column === 0 && (suite.title === file || suite.title === basename);
    if (suite.title && !isRootFileSuite) {
      result.push({
        title: suite.title,
        file: suite.file ?? file,
        line: suite.line ?? 0,
        column: suite.column ?? 0,
        specs,
        suites: childSuites,
      });
    } else {
      // Root file-level suite: hoist its children up
      result.push(...childSuites);
      // Also hoist any top-level specs (tests outside describe blocks)
      if (specs.length > 0) {
        result.push({
          title: '',
          file: suite.file ?? file,
          line: 0,
          column: 0,
          specs,
          suites: [],
        });
      }
    }
  }
  return result;
}

export async function discoverTestsInFile(
  projectPath: string,
  file: string,
): Promise<
  { specs: TestSpec[]; suites: TestSuite[]; projects: string[] } | { error: string; status: number }
> {
  try {
    log.info('Discovering tests in file', { namespace: 'test-runner', projectPath, file });
    const proc = Bun.spawn(['npx', 'playwright', 'test', file, '--list', '--reporter=json'], {
      cwd: projectPath,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;

    log.info('Playwright list result', {
      namespace: 'test-runner',
      file,
      exitCode,
      stdoutLen: stdout.length,
      stderrLen: stderr.length,
      stderrPreview: stderr.slice(0, 200),
    });

    // Playwright may exit with code 1 even when --list produces valid JSON
    // (e.g. all tests skipped, missing browsers, etc.). Try to parse stdout
    // before giving up — only fail if there's no usable output.
    let json: any;
    try {
      json = JSON.parse(stdout);
    } catch {
      if (exitCode !== 0) {
        return { error: `Playwright list failed (exit ${exitCode}): ${stderr}`, status: 500 };
      }
      return { error: `Failed to parse Playwright JSON output`, status: 500 };
    }

    const specs = walkSuitesFlat(json.suites ?? [], file);
    const suites = walkSuitesTree(json.suites ?? [], file);
    const projects: string[] = (json.config?.projects ?? [])
      .map((p: any) => p.name)
      .filter(Boolean);
    log.info('Discovered specs', { namespace: 'test-runner', file, count: specs.length, projects });
    return { specs, suites, projects };
  } catch (err) {
    log.error('discoverTestsInFile error', { namespace: 'test-runner', file, error: String(err) });
    return { error: String(err), status: 500 };
  }
}

// ─── Playwright Action Reporter (inlined, runs in user's Playwright process) ──

const ACTION_LINE_PREFIX = '__FUNNY_ACTION__';

const REPORTER_SOURCE = `
// Auto-generated by funny — custom Playwright reporter for structured action events.
// This file is deleted after each test run.
class FunnyActionReporter {
  constructor() {
    this._stepIndex = 0;
    this._stepIdMap = new WeakMap();
  }

  printsToStdio() { return true; }

  onStepBegin(test, result, step) {
    if (step.category !== 'pw:api' && step.category !== 'expect' && step.category !== 'test.step') return;
    const id = 'step-' + this._stepIndex++;
    this._stepIdMap.set(step, id);
    const selector = this._extractSelector(step.title);
    const parentId = step.parent ? this._stepIdMap.get(step.parent) : undefined;
    const payload = {
      event: 'stepBegin',
      id,
      title: step.title,
      category: step.category,
      selector: selector || undefined,
      startTime: typeof step.startTime === 'object' ? step.startTime.getTime() : step.startTime,
      parentId,
    };
    process.stdout.write('${ACTION_LINE_PREFIX}' + JSON.stringify(payload) + '\\n');
  }

  onStepEnd(test, result, step) {
    if (step.category !== 'pw:api' && step.category !== 'expect' && step.category !== 'test.step') return;
    const id = this._stepIdMap.get(step);
    const payload = {
      event: 'stepEnd',
      id: id || 'unknown',
      title: step.title,
      category: step.category,
      duration: step.duration,
      error: step.error ? step.error.message : undefined,
    };
    process.stdout.write('${ACTION_LINE_PREFIX}' + JSON.stringify(payload) + '\\n');
  }

  _extractSelector(title) {
    // Match: page.click('selector'), locator('selector'), page.fill('selector', ...), etc.
    const m = title.match(/(?:page\\.\\w+|locator|getBy\\w+)\\s*\\(\\s*['\`"]([^'\`"]+)['\`"]/);
    return m ? m[1] : null;
  }
}

module.exports = FunnyActionReporter;
`.trimStart();

const MAX_FRAME_BUFFER = 50;

/** Find the frame with timestamp closest to the target. */
function findNearestFrame(buffer: FrameSnapshot[], targetMs: number): FrameSnapshot | null {
  if (buffer.length === 0) return null;
  // Frames have CDP timestamps in seconds, targetMs is in epoch ms
  let best = buffer[0];
  let bestDist = Math.abs(best.timestamp * 1000 - targetMs);
  for (let i = 1; i < buffer.length; i++) {
    const dist = Math.abs(buffer[i].timestamp * 1000 - targetMs);
    if (dist < bestDist) {
      best = buffer[i];
      bestDist = dist;
    }
  }
  return best;
}

/** Check if a selector looks like a CSS selector (safe for querySelector). */
function isCssSelector(sel: string): boolean {
  // Simple heuristic: CSS selectors start with tag, #, ., [, or *
  return /^[a-zA-Z#.*[\]:>+~,\s]/.test(sel) && !sel.includes('(');
}

/** Try to resolve an element's bounding box via CDP. */
async function resolveBoundingBox(
  chromeSession: any,
  selector: string,
): Promise<TestActionBoundingBox | undefined> {
  if (!chromeSession || !selector || !isCssSelector(selector)) return undefined;
  try {
    const box = await Promise.race([
      chromeSession.execute(`
        (() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        })()
      `),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 150)),
    ]);
    if (box && typeof box === 'object' && 'x' in (box as any)) {
      return box as TestActionBoundingBox;
    }
  } catch {
    // Selector not found or timeout — skip
  }
  return undefined;
}

// ─── Test Execution ─────────────────────────────────────

/**
 * Check if a run's process has exited or the run has exceeded the stale timeout.
 * If so, evict it from activeRuns so it doesn't block new runs.
 */
function evictIfStale(projectId: string): void {
  const run = activeRuns.get(projectId);
  if (!run) return;

  const processExited = run.process
    ? run.process.exitCode !== null
    : Date.now() - run.startedAt > 10_000; // null process for >10s = stale
  const timedOut = Date.now() - run.startedAt > STALE_RUN_TIMEOUT;

  if (processExited || timedOut) {
    log.warn('Evicting stale test run', {
      namespace: 'test-runner',
      projectId,
      runId: run.runId,
      reason: processExited ? 'process already exited' : 'timeout exceeded',
    });
    activeRuns.delete(projectId);
  }
}

export function isRunning(projectId: string): boolean {
  evictIfStale(projectId);
  return activeRuns.has(projectId);
}

export async function runTest(
  projectId: string,
  projectPath: string,
  file: string,
  userId: string,
  line?: number,
  projects?: string[],
): Promise<{ runId: string } | { error: string; status: number }> {
  evictIfStale(projectId);
  if (activeRuns.has(projectId)) {
    return { error: 'A test is already running', status: 409 };
  }

  const runId = randomUUID();
  const run: ActiveRun = {
    runId,
    file,
    projectId,
    userId,
    process: null,
    chromeSession: null,
    startedAt: Date.now(),
    frameBuffer: [],
    stepCounter: 0,
  };
  activeRuns.set(projectId, run);

  // Emit running status
  wsBroker.emitToUser(userId, {
    type: 'test:status',
    threadId: projectId,
    data: { status: 'running', file, runId },
  });

  try {
    // Write a wrapper config that injects --remote-debugging-port and our custom
    // action reporter into the user's Playwright config.
    const wrapperConfigPath = join(projectPath, '.playwright.funny.config.ts');
    const reporterPath = join(projectPath, '.funny-action-reporter.cjs');
    await writeFile(reporterPath, REPORTER_SOURCE, 'utf-8');

    const wrapperConfig = `
import { defineConfig } from '@playwright/test';
import baseConfig from './playwright.config';

export default defineConfig({
  ...baseConfig,
  reporter: [
    ['line'],
    ['./.funny-action-reporter.cjs'],
  ],
  use: {
    ...baseConfig.use,
    launchOptions: {
      ...(baseConfig.use as any)?.launchOptions,
      args: [
        ...((baseConfig.use as any)?.launchOptions?.args ?? []),
        '--remote-debugging-port=${CDP_PORT}',
      ],
    },
  },
});
`.trimStart();
    await writeFile(wrapperConfigPath, wrapperConfig, 'utf-8');

    // Spawn Playwright test process
    const testTarget = line ? `${file}:${line}` : file;
    const projectArgs = projects?.length ? projects.flatMap((p) => ['--project', p]) : [];
    const proc = Bun.spawn(
      [
        'npx',
        'playwright',
        'test',
        testTarget,
        '--config',
        '.playwright.funny.config.ts',
        ...projectArgs,
      ],
      {
        cwd: projectPath,
        env: { ...process.env },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    run.process = proc;

    // Stream stdout
    if (proc.stdout) {
      streamLines(proc.stdout, 'stdout', projectId, userId);
    }

    // Stream stderr
    if (proc.stderr) {
      streamLines(proc.stderr, 'stderr', projectId, userId);
    }

    // Try to connect CDP for browser streaming
    connectCDP(projectId, userId, file, runId).catch((err) => {
      log.warn('CDP connection failed — running without browser stream', {
        namespace: 'test-runner',
        error: String(err),
      });
    });

    // Wait for process to exit
    const exitCode = await proc.exited;

    // Cleanup
    await unlink(wrapperConfigPath).catch(() => {});
    await unlink(reporterPath).catch(() => {});
    const currentRun = activeRuns.get(projectId);
    if (currentRun?.runId === runId) {
      if (currentRun.chromeSession) {
        try {
          await currentRun.chromeSession.disconnect();
        } catch {}
      }
      activeRuns.delete(projectId);

      const status: TestFileStatus = exitCode === 0 ? 'passed' : 'failed';
      wsBroker.emitToUser(userId, {
        type: 'test:status',
        threadId: projectId,
        data: { status, file, runId, exitCode: exitCode ?? undefined },
      });
    }
  } catch (err) {
    await unlink(wrapperConfigPath).catch(() => {});
    await unlink(reporterPath).catch(() => {});
    const currentRun = activeRuns.get(projectId);
    if (currentRun?.runId === runId) {
      activeRuns.delete(projectId);
      wsBroker.emitToUser(userId, {
        type: 'test:status',
        threadId: projectId,
        data: {
          status: 'failed',
          file,
          runId,
          error: String(err),
        },
      });
    }
  }

  return { runId };
}

async function streamLines(
  stream: ReadableStream<Uint8Array>,
  streamName: 'stdout' | 'stderr',
  projectId: string,
  userId: string,
) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.trim()) {
          if (line.startsWith(ACTION_LINE_PREFIX)) {
            // Parse structured action line from our custom reporter
            handleActionLine(line, projectId, userId);
          } else {
            wsBroker.emitToUser(userId, {
              type: 'test:output',
              threadId: projectId,
              data: { line, stream: streamName },
            });
          }
        }
      }
    }

    // Flush remaining buffer
    if (buffer.trim()) {
      if (buffer.startsWith(ACTION_LINE_PREFIX)) {
        handleActionLine(buffer, projectId, userId);
      } else {
        wsBroker.emitToUser(userId, {
          type: 'test:output',
          threadId: projectId,
          data: { line: buffer, stream: streamName },
        });
      }
    }
  } catch {
    // Stream closed
  }
}

/** Parse a __FUNNY_ACTION__ line and emit as test:action event. */
function handleActionLine(line: string, projectId: string, userId: string) {
  try {
    const json = JSON.parse(line.slice(ACTION_LINE_PREFIX.length));
    const run = activeRuns.get(projectId);

    if (json.event === 'stepBegin') {
      const action: WSTestActionData = {
        id: json.id,
        title: json.title,
        category: json.category,
        selector: json.selector,
        startTime: json.startTime,
        parentId: json.parentId,
      };

      // Correlate with nearest frame
      if (run?.frameBuffer.length) {
        const nearest = findNearestFrame(run.frameBuffer, json.startTime);
        if (nearest) action.frameTimestamp = nearest.timestamp;
      }

      // Resolve bounding box asynchronously (fire-and-forget, then send update)
      if (json.selector && run?.chromeSession) {
        resolveBoundingBox(run.chromeSession, json.selector).then((bbox) => {
          if (bbox) {
            // Send an update with the bounding box
            wsBroker.emitToUser(userId, {
              type: 'test:action',
              threadId: projectId,
              data: { ...action, boundingBox: bbox },
            });
          }
        });
      }

      wsBroker.emitToUser(userId, {
        type: 'test:action',
        threadId: projectId,
        data: action,
      });
    } else if (json.event === 'stepEnd') {
      wsBroker.emitToUser(userId, {
        type: 'test:action',
        threadId: projectId,
        data: {
          id: json.id,
          title: json.title,
          category: json.category,
          startTime: 0, // stepEnd — client matches by id
          endTime: json.startTime ? json.startTime + (json.duration ?? 0) : Date.now(),
          duration: json.duration,
          error: json.error,
        },
      });
    }
  } catch (err) {
    log.warn('Failed to parse action line', {
      namespace: 'test-runner',
      error: String(err),
      line: line.slice(0, 200),
    });
  }
}

async function connectCDP(projectId: string, userId: string, file: string, runId: string) {
  const { ChromeSession, waitForChrome } = await import('@funny/core/chrome');

  log.info('Attempting CDP connection', { namespace: 'test-runner', port: CDP_PORT });

  // Wait for Chrome to be available (up to 30s)
  try {
    await waitForChrome('localhost', CDP_PORT, 30_000);
  } catch (err) {
    log.warn('waitForChrome timed out', {
      namespace: 'test-runner',
      port: CDP_PORT,
      error: String(err),
    });
    wsBroker.emitToUser(userId, {
      type: 'test:status',
      threadId: projectId,
      data: {
        status: 'running',
        file,
        runId,
        error: 'Chrome debug port not available',
      },
    });
    return;
  }

  const run = activeRuns.get(projectId);
  if (!run || run.runId !== runId) return; // Run was stopped before CDP connected

  log.info('Chrome is ready, creating session', { namespace: 'test-runner', port: CDP_PORT });

  const session = new ChromeSession({
    host: 'localhost',
    port: CDP_PORT,
    format: 'jpeg',
    quality: 60,
    maxWidth: 1280,
    maxHeight: 720,
    everyNthFrame: 1,
  });

  run.chromeSession = session;

  let frameCount = 0;
  session.on('frame', (frame: { data: string; timestamp: number; sessionId: number }) => {
    frameCount++;
    if (frameCount <= 3) {
      log.info('CDP frame received', {
        namespace: 'test-runner',
        frameCount,
        dataLen: frame.data.length,
      });
    }

    // Store in frame ring buffer for action-frame correlation
    if (run.frameBuffer.length < MAX_FRAME_BUFFER) {
      run.frameBuffer.push({ data: frame.data, timestamp: frame.timestamp });
    } else {
      run.frameBuffer[frameCount % MAX_FRAME_BUFFER] = {
        data: frame.data,
        timestamp: frame.timestamp,
      };
    }

    wsBroker.emitToUser(userId, {
      type: 'test:frame',
      threadId: projectId,
      data: {
        data: frame.data,
        timestamp: frame.timestamp,
      },
    });
  });

  session.on('console', (entry: any) => {
    wsBroker.emitToUser(userId, {
      type: 'test:console',
      threadId: projectId,
      data: entry,
    });
  });

  session.on('error', (entry: any) => {
    wsBroker.emitToUser(userId, {
      type: 'test:error',
      threadId: projectId,
      data: entry,
    });
  });

  session.on('network', (entry: any) => {
    wsBroker.emitToUser(userId, {
      type: 'test:network',
      threadId: projectId,
      data: entry,
    });
  });

  session.on('disconnect', () => {
    log.info('CDP session disconnected', { namespace: 'test-runner' });
  });

  try {
    await session.connect();
    log.info('CDP session connected successfully', { namespace: 'test-runner' });
  } catch (err) {
    log.warn('Failed to connect CDP session', {
      namespace: 'test-runner',
      error: String(err),
    });
  }
}

export async function stopTest(projectId: string, userId: string): Promise<void> {
  const run = activeRuns.get(projectId);
  if (!run) return;

  const { file, runId } = run;

  // Kill the process
  if (run.process) {
    try {
      run.process.kill();
    } catch {}
  }

  // Disconnect CDP
  if (run.chromeSession) {
    try {
      await run.chromeSession.disconnect();
    } catch {}
  }

  activeRuns.delete(projectId);

  wsBroker.emitToUser(userId, {
    type: 'test:status',
    threadId: projectId,
    data: { status: 'stopped', file, runId },
  });
}
