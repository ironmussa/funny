import { mkdir } from 'node:fs/promises';
import { arch, cpus, platform, totalmem } from 'node:os';
import { resolve } from 'node:path';

import {
  BENCHMARK_PROTOCOL_VERSION,
  BENCHMARK_RESULT_SCHEMA_VERSION,
  BENCHMARK_THEME,
  BENCHMARK_WORKLOAD_NAMES,
  BENCHMARK_CAPABILITY_SCHEMA_VERSION,
  encodeBenchmarkMessage,
  makeRendererBenchmarkFixtures,
  parseBenchmarkEvent,
  parseBenchmarkResult,
  summarizeMetricSamples,
  unsupportedCapability,
  type BenchmarkCapabilities,
  type BenchmarkCommand,
  type BenchmarkEvent,
  type BenchmarkResult,
  type MetricSample,
  type WorkloadResult,
} from '../packages/client-benchmark/src/index';
import {
  controlledHostSupport,
  createUnsupportedGpuixResult,
} from './renderer-benchmark/host-support';
import { sampleProcessTree, type ProcessTreeSample } from './renderer-benchmark/process-sampler';
import { workloadCommands } from './renderer-benchmark/workload-plan';

type RendererKind = 'web-virtual' | 'web-frozen' | 'gpuix';

interface TimedEvent {
  event: BenchmarkEvent;
  receivedAtMs: number;
}

interface SessionResult {
  renderer: RendererKind;
  startedAtMs: number;
  finishedAtMs: number;
  events: TimedEvent[];
  processSamples: ProcessTreeSample[];
  exitCode: number;
  timedOut: boolean;
  invalidOutput: string[];
}

interface ProfileOptions {
  smoke: boolean;
  warmupCount: number;
  measuredCount: number;
  includeFrozen: boolean;
  timeoutMs: number;
}

const repositoryRoot = resolve(import.meta.dir, '..');
const resultsRoot = resolve(repositoryRoot, 'benchmark-results');
const browserBuildDirectory = resolve(resultsRoot, '.build', 'client');

function optionValue(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function optionsFromArguments(): ProfileOptions {
  const smoke = process.argv.includes('--smoke');
  return {
    smoke,
    warmupCount: Number(optionValue('warmups') ?? (smoke ? 0 : 1)),
    measuredCount: Number(optionValue('measured') ?? (smoke ? 1 : 4)),
    includeFrozen: !process.argv.includes('--no-frozen'),
    timeoutMs: Number(optionValue('timeout-ms') ?? (smoke ? 60_000 : 300_000)),
  };
}

async function runChecked(command: string[], cwd = repositoryRoot): Promise<void> {
  const child = Bun.spawn({
    cmd: command,
    cwd,
    env: { ...process.env, VITE_BENCHMARK_TARGET: 'thread' },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command.join(' ')} exited with ${exitCode}`);
}

async function buildAdapters(): Promise<void> {
  await mkdir(browserBuildDirectory, { recursive: true });
  await runChecked(
    [
      'bun',
      'x',
      'vite',
      'build',
      '--outDir',
      browserBuildDirectory,
      '--emptyOutDir',
      '--logLevel',
      'error',
    ],
    resolve(repositoryRoot, 'packages/client'),
  );
  await runChecked(['bun', 'run', '--cwd', 'packages/client-gpuix-benchmark', 'build']);
  await runChecked(['bun', 'run', '--cwd', 'packages/client-gpuix', 'build:profile']);
}

function commandForRenderer(renderer: RendererKind): string[] {
  if (renderer === 'gpuix') {
    return ['bun', 'packages/client-gpuix/dist/profile-cli.js'];
  }
  return [
    'bun',
    'scripts/renderer-benchmark/browser-adapter.ts',
    `--viewer=${renderer === 'web-frozen' ? 'frozen' : 'virtual'}`,
    `--build-dir=${browserBuildDirectory}`,
  ];
}

function sessionCommands(runId: string, measured: boolean): BenchmarkCommand[] {
  const fixtures = makeRendererBenchmarkFixtures();
  return [
    {
      type: 'initialize',
      protocolVersion: BENCHMARK_PROTOCOL_VERSION,
      runId,
      fixtureVersion: fixtures.fixtureVersion,
    },
    ...workloadCommands(measured),
    { type: 'shutdown' as const },
  ];
}

async function readEvents(
  stream: ReadableStream<Uint8Array>,
  events: TimedEvent[],
  invalidOutput: string[],
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        events.push({ event: parseBenchmarkEvent(line), receivedAtMs: Date.now() });
      } catch {
        invalidOutput.push(line);
      }
    }
  }
  if (buffer.trim()) {
    try {
      events.push({ event: parseBenchmarkEvent(buffer), receivedAtMs: Date.now() });
    } catch {
      invalidOutput.push(buffer);
    }
  }
}

async function runSession(
  renderer: RendererKind,
  runId: string,
  measured: boolean,
  timeoutMs: number,
): Promise<SessionResult> {
  const child = Bun.spawn({
    cmd: commandForRenderer(renderer),
    cwd: repositoryRoot,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const startedAtMs = Date.now();
  const events: TimedEvent[] = [];
  const invalidOutput: string[] = [];
  const processSamples: ProcessTreeSample[] = [];
  let sampling = true;
  let timedOut = false;
  const reading = readEvents(child.stdout, events, invalidOutput);
  const samplingTask = (async () => {
    while (sampling) {
      const sample = await sampleProcessTree(child.pid);
      if (sample) processSamples.push(sample);
      await Bun.sleep(100);
    }
  })();
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  for (const command of sessionCommands(runId, measured)) {
    child.stdin.write(encodeBenchmarkMessage(command));
  }
  child.stdin.flush();
  child.stdin.end();
  const exitCode = await child.exited;
  clearTimeout(timeout);
  sampling = false;
  await Promise.all([reading, samplingTask]);
  return {
    renderer,
    startedAtMs,
    finishedAtMs: Date.now(),
    events,
    processSamples,
    exitCode,
    timedOut,
    invalidOutput,
  };
}

function samplesDuring(
  session: SessionResult,
  startedAtMs: number,
  finishedAtMs: number,
): ProcessTreeSample[] {
  return session.processSamples.filter(
    (sample) => sample.timestampMs >= startedAtMs && sample.timestampMs <= finishedAtMs,
  );
}

function fittedSlope(samples: readonly ProcessTreeSample[]): number {
  if (samples.length < 2) return 0;
  const origin = samples[0]?.timestampMs ?? 0;
  const points = samples.map((sample) => ({
    x: (sample.timestampMs - origin) / 1_000,
    y: sample.rssBytes,
  }));
  const meanX = points.reduce((total, point) => total + point.x, 0) / points.length;
  const meanY = points.reduce((total, point) => total + point.y, 0) / points.length;
  const numerator = points.reduce(
    (total, point) => total + (point.x - meanX) * (point.y - meanY),
    0,
  );
  const denominator = points.reduce((total, point) => total + (point.x - meanX) ** 2, 0);
  return denominator === 0 ? 0 : numerator / denominator;
}

function processMetricSamples(samples: readonly ProcessTreeSample[]): MetricSample[] {
  return samples.flatMap((sample) => [
    {
      metric: 'process-tree-rss',
      value: sample.rssBytes,
      unit: 'bytes' as const,
      timestampMs: sample.timestampMs,
      valid: true,
    },
    {
      metric: 'process-tree-cpu',
      value: sample.cpuPercent / 100,
      unit: 'percent' as const,
      timestampMs: sample.timestampMs,
      valid: true,
    },
  ]);
}

function memoryGrowthSamples(samples: readonly ProcessTreeSample[]): MetricSample[] {
  if (samples.length < 2) return [];
  const initial = samples[0]?.rssBytes ?? 0;
  const final = samples.at(-1)?.rssBytes ?? initial;
  const peak = Math.max(...samples.map((sample) => sample.rssBytes));
  const timestampMs = samples.at(-1)?.timestampMs ?? Date.now();
  return [
    { metric: 'rss-initial', value: initial, unit: 'bytes', timestampMs, valid: true },
    { metric: 'rss-peak', value: peak, unit: 'bytes', timestampMs, valid: true },
    { metric: 'rss-final', value: final, unit: 'bytes', timestampMs, valid: true },
    {
      metric: 'rss-growth-ratio',
      value: initial === 0 ? 0 : (final - initial) / initial,
      unit: 'percent',
      timestampMs,
      valid: true,
    },
    {
      metric: 'rss-growth-slope',
      value: fittedSlope(samples),
      unit: 'bytes-per-second',
      timestampMs,
      valid: true,
    },
  ];
}

function sessionWorkloads(session: SessionResult): Map<string, WorkloadResult> {
  const results = new Map<string, WorkloadResult>();
  const completions = session.events.filter(
    (candidate) => candidate.event.type === 'workload-completed',
  );
  const ready = session.events.find((candidate) => candidate.event.type === 'ready');
  for (const [completionIndex, completed] of completions.entries()) {
    if (completed.event.type !== 'workload-completed') continue;
    const completedId = completed.event.id;
    const name = completedId.replace(/-\d+$/, '');
    const previousBoundary =
      completionIndex === 0
        ? (ready?.receivedAtMs ?? session.startedAtMs)
        : (completions[completionIndex - 1]?.receivedAtMs ?? session.startedAtMs);
    const processSamples = samplesDuring(session, previousBoundary, completed.receivedAtMs);
    const samples = [...completed.event.samples, ...processMetricSamples(processSamples)];
    if (name === 'repeated-navigation') samples.push(...memoryGrowthSamples(processSamples));
    results.set(name, {
      name: name as WorkloadResult['name'],
      status: 'complete',
      samples,
      summaries: [],
      diagnostics: completed.event.diagnostics,
    });
  }
  if (ready) {
    const cold = results.get('cold-ready');
    const capabilities = ready.event.type === 'ready' ? ready.event.capabilities : null;
    if (cold && capabilities?.capabilities.presentationAcknowledgement.status === 'supported') {
      cold.samples.push({
        metric: 'cold-ready',
        value: ready.receivedAtMs - session.startedAtMs,
        unit: 'ms',
        timestampMs: ready.receivedAtMs,
        valid: true,
      });
    }
  }
  return results;
}

function summarizeWorkloads(sessions: readonly SessionResult[]): WorkloadResult[] {
  return BENCHMARK_WORKLOAD_NAMES.map((name, workloadIndex) => {
    const instances = sessions
      .map((session) => sessionWorkloads(session).get(name))
      .filter((workload): workload is WorkloadResult => Boolean(workload));
    const samples = instances.flatMap((workload) => workload.samples);
    const groups = new Map<string, MetricSample[]>();
    for (const sample of samples) {
      const key = `${sample.metric}:${sample.unit}`;
      groups.set(key, [...(groups.get(key) ?? []), sample]);
    }
    return {
      name,
      status: instances.length === sessions.length ? 'complete' : 'failed',
      samples,
      summaries: [...groups.values()].map((group, groupIndex) =>
        summarizeMetricSamples(group, {
          bootstrapSeed: 0x46554e4e + workloadIndex * 100 + groupIndex,
          bootstrapIterations: 1_000,
        }),
      ),
      diagnostics: instances.at(-1)?.diagnostics ?? {},
      ...(instances.length === sessions.length
        ? {}
        : { error: `Completed ${instances.length}/${sessions.length} sessions` }),
    };
  });
}

async function commandOutput(command: string[]): Promise<string | null> {
  const child = Bun.spawn({ cmd: command, cwd: repositoryRoot, stdout: 'pipe', stderr: 'ignore' });
  const output = (await new Response(child.stdout).text()).trim();
  return (await child.exited) === 0 && output ? output : null;
}

async function powerState(): Promise<string | null> {
  if (platform() === 'linux') {
    for (const path of [
      '/sys/class/power_supply/AC/online',
      '/sys/class/power_supply/ACAD/online',
    ]) {
      const file = Bun.file(path);
      if (await file.exists()) return (await file.text()).trim() === '1' ? 'ac' : 'battery';
    }
  }
  if (platform() === 'darwin') return commandOutput(['pmset', '-g', 'batt']);
  return null;
}

async function gpuIdentity(): Promise<string | null> {
  if (platform() === 'linux') {
    const output = await commandOutput(['lspci']);
    return output?.split('\n').find((line) => /VGA|3D controller/i.test(line)) ?? null;
  }
  if (platform() === 'darwin') {
    const output = await commandOutput(['system_profiler', 'SPDisplaysDataType']);
    return (
      output
        ?.split('\n')
        .find((line) => line.includes('Chipset Model:'))
        ?.trim() ?? null
    );
  }
  return null;
}

async function rendererVersion(renderer: RendererKind): Promise<string> {
  if (renderer === 'gpuix') return 'react@19.2.4 + @gpuix/react@0.5.1 + @gpuix/native@0.5.1';
  const playwright = JSON.parse(
    await Bun.file(resolve(repositoryRoot, 'node_modules/playwright/package.json')).text(),
  ) as { version: string };
  const { chromium } = await import('playwright');
  const chromiumVersion = await commandOutput([chromium.executablePath(), '--version']);
  return `react@19.2.4 + playwright@${playwright.version} + ${chromiumVersion ?? 'Chromium version unavailable'}`;
}

function firstReady(sessions: readonly SessionResult[]): {
  capabilities: BenchmarkCapabilities;
  featureInventory: BenchmarkResult['fixture']['featureInventory'];
} | null {
  for (const session of sessions) {
    for (const candidate of session.events) {
      if (candidate.event.type === 'ready') return candidate.event;
    }
  }
  return null;
}

function failedCapabilities(renderer: RendererKind): BenchmarkCapabilities {
  const unavailable = () => unsupportedCapability('Renderer did not complete initialization');
  return {
    schemaVersion: BENCHMARK_CAPABILITY_SCHEMA_VERSION,
    renderer,
    capabilities: {
      frameTiming: unavailable(),
      presentationAcknowledgement: unavailable(),
      gpuMemory: unavailable(),
      screenshot: unavailable(),
      processSampling: unavailable(),
    },
  };
}

async function buildResult(
  renderer: RendererKind,
  sessions: readonly SessionResult[],
  options: ProfileOptions,
): Promise<BenchmarkResult> {
  const fixtures = makeRendererBenchmarkFixtures();
  const workloads = summarizeWorkloads(sessions);
  const lastDiagnostics = workloads.at(-1)?.diagnostics ?? {};
  const reasons = sessions.flatMap((session) => [
    ...(session.exitCode === 0 ? [] : [`session exited with ${session.exitCode}`]),
    ...(session.timedOut ? ['session timed out'] : []),
    ...session.invalidOutput.map((line) => `invalid adapter output: ${line}`),
    ...session.events
      .filter((candidate) => candidate.event.type === 'error')
      .map((candidate) =>
        candidate.event.type === 'error'
          ? `${candidate.event.code}: ${candidate.event.message}`
          : '',
      ),
  ]);
  const ready = firstReady(sessions);
  if (!ready) reasons.push('renderer never emitted a ready event');
  return parseBenchmarkResult({
    schemaVersion: BENCHMARK_RESULT_SCHEMA_VERSION,
    runId: `${renderer}-${sessions[0]?.startedAtMs ?? Date.now()}`,
    status: reasons.length === 0 ? 'complete' : 'failed',
    renderer: {
      family: renderer === 'gpuix' ? 'react-gpuix-gpui' : 'react-dom-chromium',
      variant: renderer === 'gpuix' ? 'product' : renderer.replace('web-', ''),
      version: await rendererVersion(renderer),
      runtimeVersion: `bun@${Bun.version}`,
    },
    fixture: {
      version: fixtures.fixtureVersion,
      checksums: { a: fixtures.a.checksum, b: fixtures.b.checksum },
      featureInventory: ready?.featureInventory ?? fixtures.a.featureInventory,
      messageCount: Number(lastDiagnostics.messageCount ?? 500),
      toolCallCount: fixtures.a.counts.toolCalls,
      retainedItemCount:
        typeof lastDiagnostics.retainedItemCount === 'number'
          ? lastDiagnostics.retainedItemCount
          : null,
      visibleItemCount:
        typeof lastDiagnostics.visibleItemCount === 'number'
          ? lastDiagnostics.visibleItemCount
          : null,
    },
    environment: {
      gitRevision: (await commandOutput(['git', 'rev-parse', 'HEAD'])) ?? 'unknown',
      os: platform(),
      architecture: arch(),
      cpu: cpus()[0]?.model ?? 'unknown',
      gpu: await gpuIdentity(),
      totalMemoryBytes: totalmem(),
      powerState: await powerState(),
      viewport: { width: 1440, height: 900 },
      theme: BENCHMARK_THEME,
      refreshTargetHz: 60,
      buildMode: 'release',
      startedAt: new Date(
        Math.min(...sessions.map((session) => session.startedAtMs)),
      ).toISOString(),
      finishedAt: new Date(
        Math.max(...sessions.map((session) => session.finishedAtMs)),
      ).toISOString(),
    },
    configuration: {
      warmupCount: options.warmupCount,
      measuredCount: sessions.length,
      order: 'ABBA',
    },
    capabilities: ready?.capabilities ?? failedCapabilities(renderer),
    workloads,
    validity: { valid: reasons.length === 0, reasons },
  });
}

function pairedOrder(measuredCount: number): RendererKind[] {
  const counts = { 'web-virtual': 0, gpuix: 0 };
  const order: RendererKind[] = [];
  const pattern: RendererKind[] = ['web-virtual', 'gpuix', 'gpuix', 'web-virtual'];
  while (counts['web-virtual'] < measuredCount || counts.gpuix < measuredCount) {
    for (const renderer of pattern) {
      if (counts[renderer as 'web-virtual' | 'gpuix'] >= measuredCount) continue;
      order.push(renderer);
      counts[renderer as 'web-virtual' | 'gpuix'] += 1;
    }
  }
  return order;
}

async function main(): Promise<void> {
  const options = optionsFromArguments();
  const hostSupport = controlledHostSupport(platform());
  if (!hostSupport.supported) {
    const timestamp = new Date().toISOString();
    const outputDirectory = resolve(resultsRoot, timestamp.replaceAll(':', '-'));
    await mkdir(outputDirectory, { recursive: true });
    const result = createUnsupportedGpuixResult({
      platform: platform(),
      architecture: arch(),
      cpu: cpus()[0]?.model ?? 'unknown',
      totalMemoryBytes: totalmem(),
      gitRevision: (await commandOutput(['git', 'rev-parse', 'HEAD'])) ?? 'unknown',
      reason: hostSupport.reason ?? 'Controlled renderer profiling is unsupported',
      timestamp,
    });
    await Bun.write(resolve(outputDirectory, 'gpuix.json'), `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${outputDirectory}\n`);
    return;
  }
  await buildAdapters();
  const measured = new Map<RendererKind, SessionResult[]>([
    ['web-virtual', []],
    ['web-frozen', []],
    ['gpuix', []],
  ]);
  for (let index = 0; index < options.warmupCount; index++) {
    await runSession('web-virtual', `warmup-web-${index}`, false, options.timeoutMs);
    await runSession('gpuix', `warmup-gpuix-${index}`, false, options.timeoutMs);
    if (options.includeFrozen) {
      await runSession('web-frozen', `warmup-frozen-${index}`, false, options.timeoutMs);
    }
  }
  for (const [index, renderer] of pairedOrder(options.measuredCount).entries()) {
    const session = await runSession(
      renderer,
      `measured-${renderer}-${index}`,
      !options.smoke,
      options.timeoutMs,
    );
    measured.get(renderer)?.push(session);
  }
  if (options.includeFrozen) {
    for (let index = 0; index < options.measuredCount; index++) {
      measured
        .get('web-frozen')
        ?.push(
          await runSession(
            'web-frozen',
            `measured-web-frozen-${index}`,
            !options.smoke,
            options.timeoutMs,
          ),
        );
    }
  }

  const timestamp = new Date().toISOString().replaceAll(':', '-');
  const outputDirectory = resolve(resultsRoot, timestamp);
  await mkdir(outputDirectory, { recursive: true });
  for (const renderer of [
    'web-virtual',
    'gpuix',
    ...(options.includeFrozen ? ['web-frozen'] : []),
  ] as RendererKind[]) {
    const sessions = measured.get(renderer) ?? [];
    const result = await buildResult(renderer, sessions, options);
    await Bun.write(
      resolve(outputDirectory, `${renderer}.json`),
      `${JSON.stringify(result, null, 2)}\n`,
    );
  }
  process.stdout.write(`${outputDirectory}\n`);
}

await main();
