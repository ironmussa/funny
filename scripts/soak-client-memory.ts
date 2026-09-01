import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { chromium, type APIResponse, type Browser, type CDPSession, type Page } from 'playwright';

import {
  analyzeClientMemorySoak,
  renderClientMemoryReport,
  type ClientMemorySample,
  type SoakPhaseName,
} from './client-memory-soak/analyze';
import { sampleDetailedProcessTree } from './renderer-benchmark/process-sampler';

interface Options {
  baseUrl: string;
  sampleIntervalMs: number;
  phaseDurationMs: number;
  releaseDurationMs: number;
  headless: boolean;
  smoke: boolean;
  skipBrowser: boolean;
  skipTerminal: boolean;
}

interface HarnessState {
  browser?: Browser;
  page?: Page;
  cdp?: CDPSession;
  projectId?: string;
  threadId?: string;
  tempRepo?: string;
  profilerSessionId: string | null;
}

interface MemoryProfilerApi {
  status(): { active: boolean; sessionId?: string | null };
  start(options: { intervalMs: number; maxSamples: number; label: string }): {
    sessionId?: string | null;
  };
  mark(label: string): void;
  getSamples(): Array<{
    values?: { workers?: { byKind?: Record<string, { live?: number }> } };
  }>;
}

type MemoryProfilerWindow = typeof window & { __funnyMemory?: MemoryProfilerApi };

const repositoryRoot = resolve(import.meta.dir, '..');
const MIB = 1024 * 1024;

function optionValue(name: string): string | null {
  const prefix = `--${name}=`;
  const value = process.argv.find((argument) => argument.startsWith(prefix));
  return value ? value.slice(prefix.length) : null;
}

function positiveNumber(name: string, fallback: number): number {
  const raw = optionValue(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be positive`);
  return value;
}

function readOptions(): Options {
  const smoke = process.argv.includes('--smoke');
  return {
    baseUrl: (
      optionValue('base-url') ??
      process.env.PLAYWRIGHT_BASE_URL ??
      'http://localhost:5173'
    ).replace(/\/$/, ''),
    sampleIntervalMs: positiveNumber('sample-ms', smoke ? 250 : 30_000),
    phaseDurationMs: positiveNumber('phase-ms', smoke ? 1_000 : 20 * 60_000),
    releaseDurationMs: positiveNumber('release-ms', smoke ? 1_000 : 5 * 60_000),
    headless: !process.argv.includes('--headed'),
    smoke,
    skipBrowser: process.argv.includes('--skip-browser'),
    skipTerminal: process.argv.includes('--skip-terminal'),
  };
}

function createTempRepository(): string {
  const directory = mkdtempSync(join(homedir(), '.funny-memory-soak-'));
  writeFileSync(join(directory, 'README.md'), '# Funny memory soak\n');
  execFileSync('git', ['init', '-q'], { cwd: directory });
  execFileSync('git', ['add', 'README.md'], { cwd: directory });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Funny Memory Soak',
      '-c',
      'user.email=memory-soak@localhost',
      'commit',
      '-qm',
      'fixture',
    ],
    { cwd: directory },
  );
  return directory;
}

function longThread(threadId: string, projectId: string) {
  const start = Date.parse('2026-01-01T00:00:00.000Z');
  const messages = Array.from({ length: 500 }, (_, index) => ({
    id: `memory-soak-message-${index}`,
    threadId,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content:
      index % 2 === 0
        ? `Memory soak request ${index}: inspect this representative long thread.`
        : `## Result ${index}\n\nRendered Markdown with **formatting**, a table, and code.\n\n| key | value |\n| --- | --- |\n| index | ${index} |\n\n\`\`\`ts\nconst sample = ${index};\n\`\`\``,
    timestamp: new Date(start + index * 1_000).toISOString(),
    model: 'sonnet-4',
    toolCalls: [],
  }));
  return {
    id: threadId,
    projectId,
    userId: 'memory-soak',
    title: 'Automated memory soak',
    mode: 'local',
    status: 'completed',
    stage: 'in_progress',
    provider: 'claude',
    permissionMode: 'autoEdit',
    model: 'sonnet-4',
    source: 'web',
    createdAt: new Date(start).toISOString(),
    messages,
    threadEvents: [],
    hasMore: false,
    hasMoreAfter: false,
    total: messages.length,
    windowStart: 0,
    queuedCount: 0,
    initInfo: { tools: ['Read', 'Write', 'Edit', 'Bash'], cwd: '/project', model: 'sonnet-4' },
    resultInfo: { status: 'completed', cost: 0, duration: 1_000 },
  };
}

async function responseJson(response: APIResponse) {
  const body = await response.text();
  if (!response.ok()) {
    throw new Error(`${response.url()} failed: ${response.status()} ${body}`);
  }
  return JSON.parse(body) as Record<string, unknown>;
}

async function prepareApplication(state: HarnessState, options: Options): Promise<void> {
  const password = process.env.E2E_ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD;
  const username = process.env.E2E_ADMIN_USERNAME ?? process.env.ADMIN_USERNAME ?? 'admin';
  if (!password)
    throw new Error('Set E2E_ADMIN_PASSWORD or ADMIN_PASSWORD before running the soak.');

  state.browser = await chromium.launch({
    headless: options.headless,
    args: ['--enable-precise-memory-info'],
  });
  const context = await state.browser.newContext({ viewport: { width: 1440, height: 900 } });
  state.page = await context.newPage();
  state.cdp = await context.newCDPSession(state.page);
  await state.cdp.send('Performance.enable');

  const signIn = await context.request.post(`${options.baseUrl}/api/auth/sign-in/username`, {
    data: { username, password },
  });
  const auth = await responseJson(signIn);
  const token = String(auth.token ?? '');
  if (!token) throw new Error('Sign-in response did not include a bearer token.');
  await responseJson(
    await context.request.put(`${options.baseUrl}/api/profile`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { setupCompleted: true },
    }),
  );

  state.tempRepo = createTempRepository();
  const project = await responseJson(
    await context.request.post(`${options.baseUrl}/api/projects`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: `MemorySoak-${Date.now()}`, path: state.tempRepo },
    }),
  );
  state.projectId = String(project.id);
  const thread = await responseJson(
    await context.request.post(`${options.baseUrl}/api/threads/idle`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        projectId: state.projectId,
        title: 'Automated memory soak',
        mode: 'local',
        prompt: 'Controlled memory fixture',
        stage: 'backlog',
      },
    }),
  );
  state.threadId = String(thread.id);
  const fixture = longThread(state.threadId, state.projectId);
  await state.page.route(`**/api/threads/${state.threadId}**`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    if (url.pathname === `/api/threads/${state.threadId}`) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(fixture),
      });
    }
    if (url.pathname === `/api/threads/${state.threadId}/events`) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"events":[]}' });
    }
    return route.continue();
  });

  await state.page.goto(options.baseUrl, { waitUntil: 'domcontentloaded' });
  await state.page.locator('#root').waitFor({ state: 'visible', timeout: 15_000 });
  await state.page
    .getByTestId(`project-item-${state.projectId}`)
    .waitFor({ state: 'visible', timeout: 30_000 });
  state.profilerSessionId = await state.page.evaluate((sampleIntervalMs) => {
    const profiler = (window as MemoryProfilerWindow)['__funnyMemory'];
    if (!profiler) return null;
    const status = profiler.status();
    if (status.active) return status.sessionId ?? null;
    return (
      profiler.start({
        intervalMs: sampleIntervalMs,
        maxSamples: 1_440,
        label: 'automated-soak',
      }).sessionId ?? null
    );
  }, options.sampleIntervalMs);
}

async function captureSample(
  state: HarnessState,
  phase: SoakPhaseName,
): Promise<ClientMemorySample> {
  const timestampMs = Date.now();
  const processSample = await sampleDetailedProcessTree(process.pid);
  const [heap, dom, profiler] = await Promise.all([
    state.cdp?.send('Runtime.getHeapUsage'),
    state.cdp?.send('Memory.getDOMCounters'),
    state.page?.evaluate(() => {
      const api = (window as MemoryProfilerWindow)['__funnyMemory'];
      if (!api) return null;
      const status = api.status();
      const latest = api.getSamples().at(-1);
      const workerKinds = latest?.values?.workers?.byKind ?? {};
      const workersLive = Object.values(workerKinds).reduce(
        (total, value) => total + Number(value.live ?? 0),
        0,
      );
      return { sessionId: status.sessionId ?? null, workersLive };
    }),
  ]);
  return {
    timestampMs,
    phase,
    process: processSample,
    heap: heap ? { usedBytes: heap.usedSize, totalBytes: heap.totalSize } : null,
    dom: dom
      ? { documents: dom.documents, nodes: dom.nodes, listeners: dom.jsEventListeners }
      : null,
    profiler: profiler ?? null,
  };
}

async function markPhase(page: Page, phase: SoakPhaseName): Promise<void> {
  await page.evaluate((label) => {
    const api = (window as MemoryProfilerWindow)['__funnyMemory'];
    api?.mark(`soak:${label}`);
  }, phase);
}

async function runPhase(
  state: HarnessState,
  samples: ClientMemorySample[],
  phase: SoakPhaseName,
  durationMs: number,
  intervalMs: number,
  exercise?: () => Promise<void>,
): Promise<void> {
  if (!state.page) throw new Error('Page is not ready');
  console.log(`phase=${phase} duration=${Math.round(durationMs / 1_000)}s`);
  await markPhase(state.page, phase);
  const deadline = Date.now() + durationMs;
  do {
    await exercise?.();
    const sample = await captureSample(state, phase);
    samples.push(sample);
    console.log(
      `  rss=${sample.process ? (sample.process.chromiumRssBytes / MIB).toFixed(1) : 'n/a'}MiB heap=${sample.heap ? (sample.heap.usedBytes / MIB).toFixed(1) : 'n/a'}MiB dom=${sample.dom?.nodes ?? 'n/a'}`,
    );
    const remaining = deadline - Date.now();
    if (remaining > 0) await Bun.sleep(Math.min(intervalMs, remaining));
  } while (Date.now() < deadline);
  samples.push(await captureSample(state, phase));
}

async function exerciseThread(page: Page): Promise<void> {
  await page.evaluate(() => {
    const rows = document.querySelectorAll<HTMLElement>('[data-virtual-row-key]');
    const last = rows.item(rows.length - 1);
    last?.scrollIntoView({ block: Math.random() > 0.5 ? 'end' : 'start' });
  });
}

async function openBrowserPanel(page: Page): Promise<void> {
  await page.getByTestId('header-more-actions').click();
  await page.getByTestId('header-menu-browser-panel').click();
  await page.getByTestId('browser-panel').waitFor({ state: 'visible', timeout: 10_000 });
  await page.getByTestId('browser-panel-url-input').fill('about:blank');
  await page.getByTestId('browser-panel-url-go').click();
}

async function closeBrowserPanel(page: Page): Promise<void> {
  await page.getByTestId('header-more-actions').click();
  await page.getByTestId('header-menu-browser-panel').click();
  await page.getByTestId('browser-panel').waitFor({ state: 'detached', timeout: 10_000 });
}

async function openTerminal(page: Page, projectId: string): Promise<void> {
  await page.getByTestId(`project-more-actions-${projectId}`).click({ force: true });
  await page.getByTestId('project-menu-open-terminal').click();
  const terminalTab = page
    .locator('.dv-tab')
    .filter({ hasText: /Terminal/i })
    .last();
  await terminalTab.waitFor({ state: 'visible', timeout: 15_000 });
  await page.evaluate(() => {
    const inputs = [...document.querySelectorAll<HTMLTextAreaElement>('.xterm-helper-textarea')];
    const input = inputs.findLast((candidate) => candidate.offsetParent !== null);
    if (!input) throw new Error('Visible xterm input was not found');
    input.focus();
  });
  await page.keyboard.type('for i in $(seq 1 200); do echo memory-soak-$i; done');
  await page.keyboard.press('Enter');
}

async function closeTerminal(page: Page): Promise<void> {
  const terminalTab = page
    .locator('.dv-tab')
    .filter({ hasText: /Terminal/i })
    .last();
  await terminalTab.locator('.dv-default-tab-action').click();
}

async function runScenario(state: HarnessState, options: Options, samples: ClientMemorySample[]) {
  const page = state.page!;
  await runPhase(state, samples, 'idle', options.phaseDurationMs, options.sampleIntervalMs);

  await page.goto(`${options.baseUrl}/projects/${state.projectId}/threads/${state.threadId}`, {
    waitUntil: 'domcontentloaded',
  });
  await page
    .locator('[data-virtual-row-key]')
    .first()
    .waitFor({ state: 'visible', timeout: 20_000 });
  await runPhase(state, samples, 'thread', options.phaseDurationMs, options.sampleIntervalMs, () =>
    exerciseThread(page),
  );

  if (!options.skipBrowser) {
    await openBrowserPanel(page);
    await runPhase(
      state,
      samples,
      'browser-open',
      options.phaseDurationMs,
      options.sampleIntervalMs,
    );
    await closeBrowserPanel(page);
    await runPhase(
      state,
      samples,
      'browser-closed',
      options.releaseDurationMs,
      options.sampleIntervalMs,
    );
  }

  if (!options.skipTerminal) {
    await openTerminal(page, state.projectId!);
    await runPhase(
      state,
      samples,
      'terminal-open',
      options.phaseDurationMs,
      options.sampleIntervalMs,
    );
    await closeTerminal(page);
    await runPhase(
      state,
      samples,
      'terminal-closed',
      options.releaseDurationMs,
      options.sampleIntervalMs,
    );
  }
}

async function cleanup(state: HarnessState, baseUrl: string): Promise<void> {
  const request = state.page?.context().request;
  if (request && state.threadId)
    await request.delete(`${baseUrl}/api/threads/${state.threadId}`).catch(() => {});
  if (request && state.projectId)
    await request.delete(`${baseUrl}/api/projects/${state.projectId}`).catch(() => {});
  await state.browser?.close().catch(() => {});
  if (state.tempRepo) rmSync(state.tempRepo, { recursive: true, force: true });
}

async function main(): Promise<void> {
  const options = readOptions();
  const state: HarnessState = { profilerSessionId: null };
  const samples: ClientMemorySample[] = [];
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDirectory = resolve(repositoryRoot, 'benchmark-results/client-memory-soak', runId);
  let error: unknown;

  try {
    await prepareApplication(state, options);
    await runScenario(state, options, samples);
  } catch (cause) {
    error = cause;
  } finally {
    const analysis = analyzeClientMemorySoak(samples);
    mkdirSync(outputDirectory, { recursive: true });
    await Bun.write(
      join(outputDirectory, 'samples.jsonl'),
      samples.map((sample) => JSON.stringify(sample)).join('\n') + '\n',
    );
    await Bun.write(
      join(outputDirectory, 'summary.json'),
      JSON.stringify(
        {
          runId,
          options,
          profilerSessionId: state.profilerSessionId,
          analysis,
          error: error instanceof Error ? error.message : error ? String(error) : null,
        },
        null,
        2,
      ) + '\n',
    );
    await Bun.write(join(outputDirectory, 'report.md'), renderClientMemoryReport(analysis));
    await cleanup(state, options.baseUrl);
    console.log(`artifacts=${outputDirectory}`);
  }

  if (error) throw error;
}

await main();
