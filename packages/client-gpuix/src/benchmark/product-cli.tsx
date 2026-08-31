import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import {
  BENCHMARK_WORKLOADS,
  benchmarkStateChecksum,
  encodeBenchmarkMessage,
  makeRendererBenchmarkFixtures,
  parseBenchmarkCommand,
  type BenchmarkEvent,
  type BenchmarkWorkloadName,
  type MetricSample,
  type RendererBenchmarkState,
} from '@funny/client-benchmark';
import {
  createRenderer,
  createRoot,
  enableAutomation,
  flushSync,
  startFrameLoop,
} from '@gpuix/react';
import React from 'react';

import { GpuixClientApp } from '../app';
import { createNativeApplicationServices } from '../application';
import { configureNativeFrameDiagnostics, readNativeFrameDiagnostics } from '../frame-diagnostics';
import { createNativeClientComposition } from '../platform/composition';
import type { NativeHeaders } from '../platform/transport';
import { createProductBenchmarkAdapter, type ProductWorkloadObservation } from './product-adapter';
import {
  PRODUCT_BENCHMARK_FILE_COUNT,
  makeProductBenchmarkFileTree,
  productBenchmarkStreamingContent,
} from './product-fixture';
import { countProductRows, type ProductAutomationTreeNode } from './product-observation';

class EmptyHeaders implements NativeHeaders {
  get(): string | null {
    return null;
  }

  forEach(): void {}
}

const fixtures = makeRendererBenchmarkFixtures();
const dataDirectory = mkdtempSync(join(tmpdir(), 'funny-gpuix-profile-'));
const composition = createNativeClientComposition({
  dataDirectory,
  persistentSession: false,
  diagnosticSink: () => undefined,
  fetch: async () => ({
    status: 200,
    ok: true,
    headers: new EmptyHeaders(),
    text: async () => '{}',
  }),
});
const application = createNativeApplicationServices(composition);
const project = {
  id: 'profile-project',
  name: 'Renderer profile',
  path: dataDirectory,
  userId: 'profile-user',
  sortOrder: 0,
  createdAt: new Date(0).toISOString(),
};
const threads = (['a', 'b'] as const).map((key) => ({
  id: fixtures[key].threadId,
  projectId: project.id,
  userId: 'profile-user',
  title: `Long thread ${key.toUpperCase()}`,
  mode: 'local' as const,
  status: 'idle' as const,
  stage: 'backlog' as const,
  provider: 'claude' as const,
  permissionMode: 'default' as const,
  model: 'sonnet' as const,
  cost: 0,
  source: 'funny' as const,
  runtime: 'local' as const,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
}));

application.authState.getState().authenticate({
  id: 'profile-user',
  username: 'profile',
  displayName: 'Profile',
  role: 'user',
});
application.navigationState.getState().replaceProjects([project]);
application.navigationState.getState().replaceProjectThreads(project.id, threads as never);
for (const key of ['a', 'b'] as const) {
  const fixture = fixtures[key];
  application.workspaceState.getState().replaceInitialPage(fixture.threadId, {
    messages: fixture.messages as never,
    hasMore: false,
    total: fixture.counts.messages,
    windowStart: 0,
  });
}
application.workspaceState.getState().selectThread(fixtures.a.threadId);
application.fileTree.state.setState({
  targetKey: `path:${dataDirectory}`,
  basePath: dataDirectory,
  files: makeProductBenchmarkFileTree(),
  loading: false,
  truncated: false,
  error: null,
  version: 1,
});
application.statusState.setState({ phase: 'ready', error: null });

const renderer = createRenderer();
renderer.init({
  title: 'Funny GPUIX product profile',
  width: 1440,
  height: 900,
});
enableAutomation(renderer);
configureNativeFrameDiagnostics(renderer, true);
const root = createRoot(renderer);
let historyListId: number | null = null;
flushSync(() =>
  root.render(
    <GpuixClientApp
      application={application}
      onHistoryList={(id) => {
        historyListId = id;
      }}
    />,
  ),
);
const frameLoop = startFrameLoop(renderer);
let state: RendererBenchmarkState = {
  fixtureKey: 'a',
  streamRevision: 0,
  inputRevision: 0,
};

function metricSample(metric: string, value: number): MetricSample {
  return {
    metric,
    value,
    unit: 'ms',
    timestampMs: performance.now(),
    valid: true,
  };
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function automationTree(): ProductAutomationTreeNode | null {
  return JSON.parse(renderer.getAutomationTree()) as ProductAutomationTreeNode | null;
}

function commitMutation(metric: string, mutation: () => void): MetricSample {
  const startedAt = performance.now();
  flushSync(mutation);
  return metricSample(metric, performance.now() - startedAt);
}

function switchThread(): void {
  state = { ...state, fixtureKey: state.fixtureKey === 'a' ? 'b' : 'a' };
  application.workspaceState.getState().selectThread(fixtures[state.fixtureKey].threadId);
}

function activeStreamingMessage() {
  const fixture = fixtures[state.fixtureKey];
  return [...fixture.messages].reverse().find((candidate) => candidate.role === 'assistant');
}

function prepareStreaming(): void {
  const fixture = fixtures[state.fixtureKey];
  const message = activeStreamingMessage();
  if (!message) return;
  application.workspaceState.getState().applyStreamingDelta({
    eventId: `profile-stream-prepare-${state.fixtureKey}`,
    messageId: message.id,
    threadId: fixture.threadId,
    revision: 0,
    mode: 'replace',
    content: productBenchmarkStreamingContent(0),
  });
}

function stream(): void {
  state = { ...state, streamRevision: state.streamRevision + 1 };
  const fixture = fixtures[state.fixtureKey];
  const message = activeStreamingMessage();
  if (!message) return;
  application.workspaceState.getState().applyStreamingDelta({
    eventId: `profile-stream-${state.streamRevision}`,
    messageId: message.id,
    threadId: fixture.threadId,
    revision: state.streamRevision,
    mode: 'replace',
    content: productBenchmarkStreamingContent(state.streamRevision),
  });
}

function input(): void {
  state = { ...state, inputRevision: state.inputRevision + 1 };
  application.navigationState.getState().patchThread(fixtures[state.fixtureKey].threadId, {
    title: `Long thread ${state.fixtureKey.toUpperCase()} · input ${state.inputRevision}`,
  });
}

function diagnostics(): Record<string, string | number | boolean | null> {
  const fixture = fixtures[state.fixtureKey];
  const counts = countProductRows(automationTree(), 900);
  return {
    messageCount: fixture.messages.length,
    retainedItemCount: counts.transcript.retained,
    visibleItemCount: counts.transcript.visible,
    visibleItemCountReason:
      counts.transcript.visible === null
        ? 'GPUIX product renderer did not expose painted row bounds'
        : null,
    fileTreeFileCount: PRODUCT_BENCHMARK_FILE_COUNT,
    fileTreeRetainedItemCount: counts.fileTree.retained,
    fileTreeVisibleItemCount: counts.fileTree.visible,
    fileTreeVisibleItemCountReason:
      counts.fileTree.visible === null
        ? 'GPUIX product renderer did not expose painted file-tree row bounds'
        : null,
    fixtureChecksumA: fixtures.a.checksum,
    fixtureChecksumB: fixtures.b.checksum,
    finalStateChecksum: benchmarkStateChecksum(fixtures, state),
    frameTimingSupported: false,
    presentationAcknowledgementSupported: false,
    productShell: true,
    ...readNativeFrameDiagnostics(renderer),
  };
}

async function runWorkload(
  name: BenchmarkWorkloadName,
  measured: boolean,
): Promise<ProductWorkloadObservation> {
  const samples: MetricSample[] = [];
  if (name === 'streaming-update') {
    flushSync(prepareStreaming);
    await delay(measured ? 500 : 250);
  }
  renderer.resetDebugFrameOverlayStats();
  switch (name) {
    case 'cold-ready':
      samples.push(metricSample('mutation-ready', 0));
      break;
    case 'idle': {
      const durationMs = measured ? (BENCHMARK_WORKLOADS.idle.durationMs ?? 60_000) : 50;
      const intervalMs = measured ? 1_000 : 10;
      const end = performance.now() + durationMs;
      while (performance.now() < end) {
        const startedAt = performance.now();
        await delay(intervalMs);
        samples.push(metricSample('idle-timer-drift', performance.now() - startedAt - intervalMs));
      }
      break;
    }
    case 'scroll': {
      if (historyListId === null) throw new Error('GPUIX product virtual list id is unavailable');
      const steps = measured ? (BENCHMARK_WORKLOADS.scroll.steps ?? 41) : 4;
      for (let step = 0; step < steps; step++) {
        const index = Math.round((499 * step) / Math.max(1, steps - 1));
        const startedAt = performance.now();
        renderer.scrollToItem(historyListId, index);
        samples.push(metricSample('scroll-command', performance.now() - startedAt));
      }
      break;
    }
    case 'thread-switch':
      samples.push(commitMutation('switch-mutation', switchThread));
      break;
    case 'streaming-update': {
      const steps = measured ? (BENCHMARK_WORKLOADS['streaming-update'].steps ?? 20) : 2;
      for (let step = 0; step < steps; step++)
        samples.push(commitMutation('stream-mutation', stream));
      break;
    }
    case 'input-present': {
      const steps = measured ? (BENCHMARK_WORKLOADS['input-present'].steps ?? 20) : 2;
      for (let step = 0; step < steps; step++)
        samples.push(commitMutation('input-mutation', input));
      break;
    }
    case 'repeated-navigation': {
      Bun.gc(true);
      await delay(measured ? 500 : 50);
      const switches = measured ? (BENCHMARK_WORKLOADS['repeated-navigation'].switches ?? 100) : 4;
      for (let index = 0; index < switches; index++)
        samples.push(commitMutation('switch-mutation', switchThread));
      Bun.gc(true);
      await delay(measured ? 2_000 : 250);
      break;
    }
  }
  if (name !== 'repeated-navigation') await delay(measured ? 500 : 250);
  return { samples, diagnostics: diagnostics() };
}

const adapter = createProductBenchmarkAdapter({
  fixtureVersion: fixtures.fixtureVersion,
  featureInventory: fixtures.a.featureInventory,
  now: () => performance.now(),
  runWorkload,
});

function writeEvents(events: BenchmarkEvent[]): void {
  for (const event of events) process.stdout.write(encodeBenchmarkMessage(event));
}

function shutdown(): void {
  frameLoop.stop();
  application.dispose();
  root.unmount();
  rmSync(dataDirectory, { recursive: true, force: true });
}

const lines = createInterface({
  input: process.stdin,
  crlfDelay: Number.POSITIVE_INFINITY,
});
let pending = Promise.resolve();
lines.on('line', (line) => {
  pending = pending.then(async () => {
    try {
      const command = parseBenchmarkCommand(line);
      writeEvents(await adapter.handleCommand(command));
      if (command.type === 'shutdown') {
        lines.close();
        shutdown();
        process.stdout.write('', () => process.exit(0));
      }
    } catch (error) {
      writeEvents([
        {
          type: 'error',
          code: 'invalid-command',
          message: error instanceof Error ? error.message : String(error),
        },
      ]);
    }
  });
});
