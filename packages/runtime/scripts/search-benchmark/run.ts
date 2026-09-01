import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

import {
  createCurrentAdapter,
  createFffAdapter,
  type SearchBenchmarkAdapter,
} from '../../src/__tests__/support/search-benchmark-adapters.js';
import {
  createCorrectnessFixture,
  createLargeFixture,
} from '../../src/__tests__/support/search-benchmark-fixture.js';

type BackendName = 'current' | 'fff';

interface ScenarioResult {
  backend: BackendName;
  roots: number;
  indexedFiles: number;
  fileReadyMs: number;
  contentReadyMs: number;
  file: LatencySummary;
  content: LatencySummary;
  rssDeltaBytes: number;
  watcherDelta: number | null;
  eventLoopDelayP95Ms: number;
  corpus: CorpusSummary;
}

interface CorpusSummary {
  count: number;
  sha256: string;
}

interface LatencySummary {
  p50Ms: number;
  p95Ms: number;
}

interface Comparison {
  scenario: string;
  current: ScenarioResult;
  fff: ScenarioResult;
  gate: {
    corpusParity: boolean;
    fileReadiness: boolean;
    contentReadiness: boolean;
    fileLatency: boolean;
    contentLatency: boolean;
  };
}

const workerIndex = process.argv.indexOf('--worker');
if (workerIndex !== -1) {
  await runWorker(
    process.argv[workerIndex + 1] as BackendName,
    process.argv[workerIndex + 2],
    process.argv[workerIndex + 3],
  );
} else {
  await runComparison();
}

async function runComparison(): Promise<void> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'funny-search-benchmark-'));
  const repositoryRoot = resolve(import.meta.dir, '../../../..');
  const outputPath = resolve(
    process.env.SEARCH_BENCH_OUTPUT ?? join(import.meta.dir, 'results.json'),
  );
  const largeFileCount = positiveInteger(process.env.SEARCH_BENCH_LARGE_FILES, 10_000);
  const rounds = positiveInteger(process.env.SEARCH_BENCH_ROUNDS, 3);
  const fffMaxThreads = positiveInteger(process.env.SEARCH_BENCH_FFF_MAX_THREADS, 1);

  try {
    const smallRoot = join(temporaryRoot, 'small');
    const largeRoot = join(temporaryRoot, 'large');
    const worktreeRoots = [0, 1, 2].map((index) => join(temporaryRoot, `worktree-${index}`));
    await Promise.all([
      createCorrectnessFixture(smallRoot),
      createLargeFixture(largeRoot, largeFileCount),
      ...worktreeRoots.map((root) => createCorrectnessFixture(root)),
    ]);

    const scenarios = [
      { name: 'current-repository', roots: [repositoryRoot] },
      { name: 'small', roots: [smallRoot] },
      { name: `large-${largeFileCount}`, roots: [largeRoot] },
      { name: 'multi-worktree-3', roots: worktreeRoots },
    ];
    const comparisons: Comparison[] = [];
    for (const [scenarioIndex, scenario] of scenarios.entries()) {
      const roundResults: Record<BackendName, ScenarioResult[]> = { current: [], fff: [] };
      for (let round = 0; round < rounds; round += 1) {
        const order: BackendName[] =
          (scenarioIndex + round) % 2 === 0 ? ['current', 'fff'] : ['fff', 'current'];
        for (const backend of order) {
          roundResults[backend].push(await invokeWorker(backend, scenario.roots, temporaryRoot));
        }
      }
      const current = aggregateRounds(roundResults.current);
      const fff = aggregateRounds(roundResults.fff);
      const corpusParity = current.corpus.sha256 === fff.corpus.sha256;
      comparisons.push({
        scenario: scenario.name,
        current,
        fff,
        gate: {
          corpusParity,
          fileReadiness: fff.fileReadyMs <= current.fileReadyMs * 1.25,
          contentReadiness: fff.contentReadyMs <= current.contentReadyMs * 1.25,
          fileLatency: corpusParity && improvesAtP50OrP95(current.file, fff.file),
          contentLatency: corpusParity && improvesAtP50OrP95(current.content, fff.content),
        },
      });
    }

    const report = {
      generatedAt: new Date().toISOString(),
      platform: `${process.platform}-${process.arch}`,
      bun: Bun.version,
      configuration: {
        largeFileCount,
        rounds,
        fffMaxThreads,
        fileIterations: positiveInteger(process.env.SEARCH_BENCH_FILE_ITERATIONS, 50),
        contentIterations: positiveInteger(process.env.SEARCH_BENCH_CONTENT_ITERATIONS, 20),
      },
      correctness: 'Run bun --bun vitest run src/__tests__/services/search-benchmark.test.ts',
      comparisons,
      passed: comparisons.every((comparison) => Object.values(comparison.gate).every(Boolean)),
    };
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`${formatReport(comparisons)}\n\nResults: ${outputPath}\n`);
    if (!report.passed) process.exitCode = 1;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function runWorker(
  backend: BackendName,
  rootsJson: string,
  outputPath: string,
): Promise<void> {
  if (backend !== 'current' && backend !== 'fff') throw new Error(`Unknown backend: ${backend}`);
  const roots = JSON.parse(rootsJson) as string[];
  const adapters: SearchBenchmarkAdapter[] = [];
  const rssBefore = process.memoryUsage.rss();
  const watchersBefore = countWatchers();
  const delay = monitorEventLoopDelay({ resolution: 1 });
  delay.enable();

  try {
    for (const root of roots) {
      adapters.push(
        backend === 'current'
          ? await createCurrentAdapter(root)
          : await createFffAdapter(root, {
              disableWatch: false,
              maxThreads: positiveInteger(process.env.SEARCH_BENCH_FFF_MAX_THREADS, 1),
            }),
      );
    }
    await immediate();
    const fileDurations: number[] = [];
    const contentDurations: number[] = [];
    const fileIterations = positiveInteger(process.env.SEARCH_BENCH_FILE_ITERATIONS, 50);
    const contentIterations = positiveInteger(process.env.SEARCH_BENCH_CONTENT_ITERATIONS, 20);

    for (const adapter of adapters) {
      for (let index = 0; index < fileIterations; index += 1) {
        const startedAt = performance.now();
        adapter.fileSearch(index % 2 === 0 ? 'generated component' : 'usr servce', 50);
        fileDurations.push(performance.now() - startedAt);
      }
      for (let index = 0; index < contentIterations; index += 1) {
        const startedAt = performance.now();
        await adapter.textSearch({
          query: index % 2 === 0 ? 'shared benchmark needle' : 'hello',
          maxResults: 100,
        });
        contentDurations.push(performance.now() - startedAt);
      }
    }
    await immediate();
    delay.disable();
    const corpus = summarizeCorpus(
      adapters.flatMap((adapter, rootIndex) =>
        adapter.listIndexedFiles().map((file) => `${rootIndex}:${file}`),
      ),
    );

    const result: ScenarioResult = {
      backend,
      roots: adapters.length,
      indexedFiles: adapters.reduce((total, adapter) => total + adapter.indexedFiles, 0),
      fileReadyMs: adapters.reduce((total, adapter) => total + adapter.fileReadyMs, 0),
      contentReadyMs: adapters.reduce((total, adapter) => total + adapter.contentReadyMs, 0),
      file: summarize(fileDurations),
      content: summarize(contentDurations),
      rssDeltaBytes: Math.max(0, process.memoryUsage.rss() - rssBefore),
      watcherDelta: subtractNullable(countWatchers(), watchersBefore),
      eventLoopDelayP95Ms: Number.isFinite(delay.percentile(95))
        ? delay.percentile(95) / 1_000_000
        : 0,
      corpus,
    };
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  } finally {
    for (const adapter of adapters) adapter.destroy();
  }
}

function summarizeCorpus(files: string[]): CorpusSummary {
  const normalizedFiles = [...new Set(files.map((file) => file.replaceAll('\\', '/')))].sort();
  return {
    count: normalizedFiles.length,
    sha256: createHash('sha256').update(normalizedFiles.join('\n')).digest('hex'),
  };
}

async function invokeWorker(
  backend: BackendName,
  roots: string[],
  temporaryRoot: string,
): Promise<ScenarioResult> {
  const outputPath = join(temporaryRoot, `${backend}-${crypto.randomUUID()}.json`);
  const child = Bun.spawn(
    [process.execPath, import.meta.path, '--worker', backend, JSON.stringify(roots), outputPath],
    { cwd: process.cwd(), env: process.env, stdout: 'inherit', stderr: 'inherit' },
  );
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${backend} benchmark worker exited with ${exitCode}`);
  return JSON.parse(await readFile(outputPath, 'utf8')) as ScenarioResult;
}

function summarize(values: number[]): LatencySummary {
  return { p50Ms: percentile(values, 50), p95Ms: percentile(values, 95) };
}

function aggregateRounds(rounds: ScenarioResult[]): ScenarioResult {
  const first = rounds[0];
  if (!first) throw new Error('Cannot aggregate an empty benchmark round set');
  for (const round of rounds.slice(1)) {
    if (round.backend !== first.backend || round.roots !== first.roots) {
      throw new Error('Benchmark round identity changed during aggregation');
    }
    if (round.corpus.sha256 !== first.corpus.sha256) {
      throw new Error(
        `${first.backend} benchmark corpus changed between rounds ` +
          `(${first.corpus.count}/${first.corpus.sha256.slice(0, 8)} -> ` +
          `${round.corpus.count}/${round.corpus.sha256.slice(0, 8)})`,
      );
    }
  }

  return {
    backend: first.backend,
    roots: first.roots,
    indexedFiles: Math.round(median(rounds.map((round) => round.indexedFiles))),
    fileReadyMs: median(rounds.map((round) => round.fileReadyMs)),
    contentReadyMs: median(rounds.map((round) => round.contentReadyMs)),
    file: {
      p50Ms: median(rounds.map((round) => round.file.p50Ms)),
      p95Ms: median(rounds.map((round) => round.file.p95Ms)),
    },
    content: {
      p50Ms: median(rounds.map((round) => round.content.p50Ms)),
      p95Ms: median(rounds.map((round) => round.content.p95Ms)),
    },
    rssDeltaBytes: median(rounds.map((round) => round.rssDeltaBytes)),
    watcherDelta: medianNullable(rounds.map((round) => round.watcherDelta)),
    eventLoopDelayP95Ms: median(rounds.map((round) => round.eventLoopDelayP95Ms)),
    corpus: first.corpus,
  };
}

function median(values: number[]): number {
  return percentile(values, 50);
}

function medianNullable(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === values.length ? median(present) : null;
}

function percentile(values: number[], requested: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil((requested / 100) * sorted.length) - 1)] ?? 0;
}

function improvesAtP50OrP95(current: LatencySummary, fff: LatencySummary): boolean {
  return fff.p50Ms <= current.p50Ms * 0.8 || fff.p95Ms <= current.p95Ms * 0.8;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function countWatchers(): number | null {
  if (process.platform !== 'linux') return null;
  try {
    const output = Bun.spawnSync([
      'bash',
      '-lc',
      `grep -h '^inotify' /proc/${process.pid}/fdinfo/* 2>/dev/null | wc -l`,
    ]);
    return Number.parseInt(output.stdout.toString().trim(), 10);
  } catch {
    return null;
  }
}

function subtractNullable(after: number | null, before: number | null): number | null {
  return after === null || before === null ? null : Math.max(0, after - before);
}

function immediate(): Promise<void> {
  return new Promise((resolvePromise) => setImmediate(resolvePromise));
}

function formatReport(comparisons: Comparison[]): string {
  const rows = comparisons.flatMap((comparison) =>
    (['current', 'fff'] as const).map((backend) => {
      const result = comparison[backend];
      return [
        comparison.scenario,
        backend,
        `${result.fileReadyMs.toFixed(1)}/${result.contentReadyMs.toFixed(1)}`,
        `${result.file.p50Ms.toFixed(2)}/${result.file.p95Ms.toFixed(2)}`,
        `${result.content.p50Ms.toFixed(2)}/${result.content.p95Ms.toFixed(2)}`,
        (result.rssDeltaBytes / 1_048_576).toFixed(1),
        String(result.watcherDelta ?? 'n/a'),
        result.eventLoopDelayP95Ms.toFixed(2),
        `${result.corpus.count}/${result.corpus.sha256.slice(0, 8)}`,
      ].join('\t');
    }),
  );
  return [
    'scenario\tbackend\tfile/content ready ms\tfile p50/p95 ms\tcontent p50/p95 ms\tRSS MiB\twatchers\tloop p95 ms\tcorpus count/hash',
    ...rows,
    '',
    ...comparisons.map(
      (comparison) =>
        `${comparison.scenario}: ${Object.values(comparison.gate).every(Boolean) ? 'PASS' : 'FAIL'} ${JSON.stringify(comparison.gate)}`,
    ),
  ].join('\n');
}
