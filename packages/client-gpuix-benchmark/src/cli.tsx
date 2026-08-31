import { createInterface } from 'node:readline';

import {
  BENCHMARK_WORKLOADS,
  encodeBenchmarkMessage,
  parseBenchmarkCommand,
  type BenchmarkEvent,
  type BenchmarkWorkloadName,
  type MetricSample,
} from '@funny/client-benchmark';
import {
  createRenderer,
  createRoot,
  enableAutomation,
  flushSync,
  startFrameLoop,
} from '@gpuix/react';
import React, { createRef } from 'react';

import { createGpuixBenchmarkAdapter, type GpuixWorkloadObservation } from './adapter';
import { GpuixBenchmarkApp, GPUIX_FIXTURES, type GpuixBenchmarkController } from './app';

function metricSample(metric: string, value: number): MetricSample {
  return { metric, value, unit: 'ms', timestampMs: performance.now(), valid: true };
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

interface AutomationTreeNode {
  testId?: string;
  bounds?: { y: number; height: number };
  children?: AutomationTreeNode[];
}

function rendererItemCounts(renderer: {
  getAutomationTree: () => string;
  getPaintedText: () => string[];
}): { retained: number; visible: number | null; paintedText: number } {
  const root = JSON.parse(renderer.getAutomationTree()) as AutomationTreeNode | null;
  let retained = 0;
  let boundedVisible = 0;
  const visit = (candidate: AutomationTreeNode) => {
    if (candidate.testId?.startsWith('message-')) {
      retained += 1;
      if (
        candidate.bounds &&
        candidate.bounds.y + candidate.bounds.height >= 0 &&
        candidate.bounds.y <= 900
      ) {
        boundedVisible += 1;
      }
    }
    candidate.children?.forEach(visit);
  };
  if (root) visit(root);
  const paintedText = renderer.getPaintedText();
  const roleCount = paintedText.filter((text) => text === 'user' || text === 'assistant').length;
  const visible = boundedVisible > 0 ? boundedVisible : roleCount > 0 ? roleCount : null;
  return { retained, visible, paintedText: paintedText.length };
}

const renderer = createRenderer();
renderer.init({ title: 'Funny GPUIX renderer benchmark', width: 1440, height: 900 });
enableAutomation(renderer);
const root = createRoot(renderer);
const controllerRef = createRef<GpuixBenchmarkController>();
flushSync(() => root.render(<GpuixBenchmarkApp ref={controllerRef} />));
const frameLoop = startFrameLoop(renderer);

function controller(): GpuixBenchmarkController {
  if (!controllerRef.current) throw new Error('GPUIX benchmark controller is unavailable');
  return controllerRef.current;
}

function diagnostics(): Record<string, string | number | boolean | null> {
  const snapshot = controller().snapshot();
  const counts = rendererItemCounts(renderer);
  return {
    messageCount: GPUIX_FIXTURES[snapshot.fixtureKey].messages.length,
    retainedItemCount: counts.retained,
    visibleItemCount: counts.visible,
    visibleItemCountReason:
      counts.visible === null
        ? 'GPUIX production renderer did not expose painted row bounds'
        : null,
    paintedTextCount: counts.paintedText,
    fixtureChecksumA: GPUIX_FIXTURES.a.checksum,
    fixtureChecksumB: GPUIX_FIXTURES.b.checksum,
    finalStateChecksum: snapshot.checksum,
    frameTimingSupported: false,
    presentationAcknowledgementSupported: false,
  };
}

function commitMutation(metric: string, mutation: () => void): MetricSample {
  const start = performance.now();
  flushSync(mutation);
  return metricSample(metric, performance.now() - start);
}

async function runWorkload(
  name: BenchmarkWorkloadName,
  measured: boolean,
): Promise<GpuixWorkloadObservation> {
  const samples: MetricSample[] = [];
  switch (name) {
    case 'cold-ready':
      samples.push(metricSample('mutation-ready', 0));
      break;
    case 'idle': {
      const durationMs = measured ? (BENCHMARK_WORKLOADS.idle.durationMs ?? 60_000) : 50;
      const intervalMs = measured ? 1_000 : 10;
      const end = performance.now() + durationMs;
      while (performance.now() < end) {
        const start = performance.now();
        await delay(intervalMs);
        samples.push(metricSample('idle-timer-drift', performance.now() - start - intervalMs));
      }
      break;
    }
    case 'scroll': {
      const listId = controller().snapshot().listId;
      if (listId === null) throw new Error('GPUIX virtual list id is unavailable');
      const steps = measured ? (BENCHMARK_WORKLOADS.scroll.steps ?? 41) : 4;
      const messageCount = GPUIX_FIXTURES.a.messages.length;
      for (let step = 0; step < steps; step++) {
        const index = Math.round(((messageCount - 1) * step) / Math.max(1, steps - 1));
        const start = performance.now();
        renderer.scrollToItem(listId, index);
        samples.push(metricSample('scroll-command', performance.now() - start));
      }
      break;
    }
    case 'thread-switch':
      samples.push(commitMutation('switch-mutation', () => controller().switchThread()));
      break;
    case 'streaming-update': {
      const steps = measured ? (BENCHMARK_WORKLOADS['streaming-update'].steps ?? 20) : 2;
      for (let step = 0; step < steps; step++) {
        samples.push(commitMutation('stream-mutation', () => controller().stream()));
      }
      break;
    }
    case 'input-present': {
      const steps = measured ? (BENCHMARK_WORKLOADS['input-present'].steps ?? 20) : 2;
      for (let step = 0; step < steps; step++) {
        samples.push(commitMutation('input-mutation', () => controller().input()));
      }
      break;
    }
    case 'repeated-navigation': {
      const switches = measured ? (BENCHMARK_WORKLOADS['repeated-navigation'].switches ?? 100) : 4;
      for (let index = 0; index < switches; index++) {
        samples.push(commitMutation('switch-mutation', () => controller().switchThread()));
      }
      break;
    }
  }
  await delay(measured ? 500 : 250);
  return { samples, diagnostics: diagnostics() };
}

const adapter = createGpuixBenchmarkAdapter({
  fixtureVersion: GPUIX_FIXTURES.fixtureVersion,
  renderer: 'react-gpuix-gpui/virtual',
  featureInventory: GPUIX_FIXTURES.a.featureInventory,
  now: () => performance.now(),
  runWorkload,
});

function writeEvents(events: BenchmarkEvent[]): void {
  for (const event of events) process.stdout.write(encodeBenchmarkMessage(event));
}

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
let pending = Promise.resolve();
lines.on('line', (line) => {
  pending = pending.then(async () => {
    try {
      const command = parseBenchmarkCommand(line);
      writeEvents(await adapter.handleCommand(command));
      if (command.type === 'shutdown') {
        lines.close();
        frameLoop.stop();
        root.unmount();
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
