import { randomUUID } from 'crypto';
import { readdir, stat } from 'fs/promises';
import { join, relative } from 'path';

import type { TestFileStatus, TestSpec } from '@funny/shared';

import { log } from '../lib/logger.js';
import { wsBroker } from './ws-broker.js';

// ─── Types ──────────────────────────────────────────────

interface ActiveRun {
  runId: string;
  file: string;
  projectId: string;
  userId: string;
  process: ReturnType<typeof Bun.spawn> | null;
  chromeSession: any | null; // ChromeSession from podman-chrome-streaming
}

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

function walkSuites(suites: any[], file: string): TestSpec[] {
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
        });
      }
    }
    if (suite.suites) {
      specs.push(...walkSuites(suite.suites, file));
    }
  }
  return specs;
}

export async function discoverTestsInFile(
  projectPath: string,
  file: string,
): Promise<{ specs: TestSpec[] } | { error: string; status: number }> {
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

    if (exitCode !== 0) {
      return { error: `Playwright list failed: ${stderr}`, status: 500 };
    }

    const json = JSON.parse(stdout);
    const specs = walkSuites(json.suites ?? [], file);
    log.info('Discovered specs', { namespace: 'test-runner', file, count: specs.length });
    return { specs };
  } catch (err) {
    log.error('discoverTestsInFile error', { namespace: 'test-runner', file, error: String(err) });
    return { error: String(err), status: 500 };
  }
}

// ─── Test Execution ─────────────────────────────────────

export function isRunning(projectId: string): boolean {
  return activeRuns.has(projectId);
}

export async function runTest(
  projectId: string,
  projectPath: string,
  file: string,
  userId: string,
  line?: number,
): Promise<{ runId: string } | { error: string; status: number }> {
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
  };
  activeRuns.set(projectId, run);

  // Emit running status
  wsBroker.emitToUser(userId, {
    type: 'test:status',
    threadId: projectId,
    data: { status: 'running', file, runId },
  });

  try {
    // Spawn Playwright test process
    const testTarget = line ? `${file}:${line}` : file;
    const proc = Bun.spawn(
      ['npx', 'playwright', 'test', testTarget, '--headed', '--reporter=line'],
      {
        cwd: projectPath,
        env: {
          ...process.env,
          PLAYWRIGHT_CHROMIUM_DEBUG_PORT: String(CDP_PORT),
        },
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
          wsBroker.emitToUser(userId, {
            type: 'test:output',
            threadId: projectId,
            data: { line, stream: streamName },
          });
        }
      }
    }

    // Flush remaining buffer
    if (buffer.trim()) {
      wsBroker.emitToUser(userId, {
        type: 'test:output',
        threadId: projectId,
        data: { line: buffer, stream: streamName },
      });
    }
  } catch {
    // Stream closed
  }
}

async function connectCDP(projectId: string, userId: string, file: string, runId: string) {
  // Dynamic import to avoid hard dependency on podman-chrome-streaming
  const { ChromeSession, waitForChrome } =
    await import('@funny/podman-chrome-streaming/stream-only').then((m) => ({
      ChromeSession: m.ChromeSession ?? (m as any).default?.ChromeSession,
      waitForChrome: m.waitForChrome ?? (m as any).default?.waitForChrome,
    }));

  if (!ChromeSession || !waitForChrome) {
    log.warn('ChromeSession not available — skipping browser stream', {
      namespace: 'test-runner',
    });
    return;
  }

  // Wait for Chrome to be available (up to 30s)
  try {
    await waitForChrome('localhost', CDP_PORT, 30_000);
  } catch {
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

  session.on('frame', (frame: { data: string; metadata: { timestamp: number } }) => {
    wsBroker.emitToUser(userId, {
      type: 'test:frame',
      threadId: projectId,
      data: {
        data: frame.data,
        timestamp: frame.metadata.timestamp,
      },
    });
  });

  try {
    await session.connect();
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
