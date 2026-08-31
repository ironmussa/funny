import {
  BENCHMARK_WORKLOADS,
  benchmarkStateChecksum,
  makeRendererBenchmarkFixtures,
  type BenchmarkCommand,
  type BenchmarkEvent,
  type BenchmarkWorkloadName,
  type MetricSample,
  type RendererFeatureInventory,
} from '@funny/client-benchmark';
import { useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

import {
  createBrowserBenchmarkAdapter,
  type BrowserWorkloadObservation,
} from '@/benchmarks/browser-benchmark-adapter';
import { FrozenMessageList } from '@/components/thread/FrozenMessageList';
import { MemoizedMessageList } from '@/components/thread/MemoizedMessageList';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ThreadProvider } from '@/stores/thread-context';

import '../globals.css';
import '../i18n/config';

type Viewer = 'virtual' | 'frozen';

export interface ThreadViewerProfile {
  viewer: Viewer;
  markdownRenderer: 'satteri';
  messageCount: number;
  initialRowCount: number;
  fixtureVersion: string;
  fixtureChecksums: { a: string; b: string };
  featureInventory: RendererFeatureInventory;
  handleCommand: (command: BenchmarkCommand) => Promise<BenchmarkEvent[]>;
  scrollSweep: () => Promise<{ meanMs: number; p95Ms: number; maxMs: number; samples: number }>;
  switchThread: () => Promise<number>;
}

declare global {
  interface Window {
    funnyThreadProfile?: ThreadViewerProfile;
  }
}

const FIXTURES = makeRendererBenchmarkFixtures();

function requiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing profiler element #${id}`);
  return element;
}

function getViewer(): Viewer {
  return new URLSearchParams(window.location.search).get('viewer') === 'frozen'
    ? 'frozen'
    : 'virtual';
}

function percentile(values: number[], percentileValue: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function nextPresentedFrame(): Promise<number> {
  await nextFrame();
  await nextFrame();
  return performance.now();
}

function metricSample(metric: string, value: number): MetricSample {
  return { metric, value, unit: 'ms', timestampMs: performance.now(), valid: true };
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function ThreadViewerFixture() {
  const viewer = getViewer();
  const [fixtureKey, setFixtureKey] = useState<'a' | 'b'>('a');
  const fixtureKeyRef = useRef<'a' | 'b'>('a');
  const [streamRevision, setStreamRevision] = useState(0);
  const streamRevisionRef = useRef(0);
  const [inputRevision, setInputRevision] = useState(0);
  const inputRevisionRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fixture = FIXTURES[fixtureKey];
  const renderedMessages = useMemo(() => {
    if (streamRevision === 0) return fixture.messages;
    return fixture.messages.map((message, index) =>
      index === fixture.messages.length - 1
        ? { ...message, content: `${message.content}\n\nstream revision ${streamRevision}` }
        : message,
    );
  }, [fixture, streamRevision]);
  const commonProps = useMemo(
    () => ({
      messages: renderedMessages,
      threadId: fixture.threadId,
      threadStatus: 'idle',
      knownIds: new Set<string>(),
      snapshotMap: new Map<string, number>(),
      onSend: () => {},
      onOpenLightbox: () => {},
      scrollRef,
    }),
    [fixture, renderedMessages],
  );

  useEffect(() => {
    let cancelled = false;
    let frame = 0;
    const publishProfile = () => {
      if (cancelled) return;
      const visibleCount = () => document.querySelectorAll('[data-virtual-row-key]').length;
      const diagnostics = () => ({
        messageCount: FIXTURES.a.messages.length,
        retainedItemCount: FIXTURES.a.messages.length,
        visibleItemCount: visibleCount(),
        fixtureChecksumA: FIXTURES.a.checksum,
        fixtureChecksumB: FIXTURES.b.checksum,
        finalStateChecksum: benchmarkStateChecksum(FIXTURES, {
          fixtureKey: fixtureKeyRef.current,
          streamRevision: streamRevisionRef.current,
          inputRevision: inputRevisionRef.current,
        }),
      });
      const switchOnce = async (): Promise<number> => {
        const start = performance.now();
        const nextKey = fixtureKeyRef.current === 'a' ? 'b' : 'a';
        fixtureKeyRef.current = nextKey;
        flushSync(() => setFixtureKey(nextKey));
        await nextPresentedFrame();
        return performance.now() - start;
      };
      const runScroll = async (acknowledgePresentation: boolean): Promise<MetricSample[]> => {
        const viewport = scrollRef.current;
        if (!viewport) throw new Error('Thread profile viewport is unavailable');
        viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
        await (acknowledgePresentation ? nextPresentedFrame() : nextFrame());
        const maxScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
        const samples: MetricSample[] = [];
        for (let step = 0; step < (BENCHMARK_WORKLOADS.scroll.steps ?? 41); step++) {
          const start = performance.now();
          viewport.scrollTop = (maxScroll * step) / 40;
          viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
          await (acknowledgePresentation ? nextPresentedFrame() : nextFrame());
          samples.push(metricSample('frame-time', performance.now() - start));
        }
        return samples;
      };
      const runWorkload = async (
        name: BenchmarkWorkloadName,
        measured: boolean,
      ): Promise<BrowserWorkloadObservation> => {
        const samples: MetricSample[] = [];
        let presentedAtMs: number | undefined;
        switch (name) {
          case 'cold-ready':
            presentedAtMs = await nextPresentedFrame();
            samples.push(metricSample('cold-ready', presentedAtMs));
            break;
          case 'idle': {
            const durationMs = measured ? (BENCHMARK_WORKLOADS.idle.durationMs ?? 60_000) : 50;
            const intervalMs = measured ? 1_000 : 10;
            const end = performance.now() + durationMs;
            while (performance.now() < end) {
              const start = performance.now();
              await delay(intervalMs);
              samples.push(
                metricSample('idle-timer-drift', performance.now() - start - intervalMs),
              );
            }
            break;
          }
          case 'scroll': {
            const frames = await runScroll(true);
            samples.push(
              ...frames,
              ...frames.map((sample) => ({ ...sample, metric: 'input-to-present' })),
            );
            presentedAtMs = performance.now();
            break;
          }
          case 'thread-switch': {
            const value = await switchOnce();
            samples.push(metricSample('switch-latency', value));
            presentedAtMs = performance.now();
            break;
          }
          case 'streaming-update': {
            const steps = measured ? (BENCHMARK_WORKLOADS['streaming-update'].steps ?? 20) : 2;
            for (let step = 0; step < steps; step++) {
              const start = performance.now();
              streamRevisionRef.current += 1;
              flushSync(() => setStreamRevision(streamRevisionRef.current));
              presentedAtMs = await nextPresentedFrame();
              samples.push(metricSample('input-to-present', presentedAtMs - start));
            }
            break;
          }
          case 'input-present': {
            const steps = measured ? (BENCHMARK_WORKLOADS['input-present'].steps ?? 20) : 2;
            for (let step = 0; step < steps; step++) {
              const start = performance.now();
              inputRevisionRef.current += 1;
              flushSync(() => setInputRevision(inputRevisionRef.current));
              presentedAtMs = await nextPresentedFrame();
              samples.push(metricSample('input-to-present', presentedAtMs - start));
            }
            break;
          }
          case 'repeated-navigation': {
            const switches = measured
              ? (BENCHMARK_WORKLOADS['repeated-navigation'].switches ?? 100)
              : 4;
            for (let index = 0; index < switches; index++) {
              samples.push(metricSample('switch-latency', await switchOnce()));
            }
            break;
          }
        }
        await delay(measured ? 500 : 250);
        return { samples, diagnostics: diagnostics(), presentedAtMs };
      };
      const adapter = createBrowserBenchmarkAdapter({
        fixtureVersion: FIXTURES.fixtureVersion,
        renderer: `react-dom-chromium/${viewer}`,
        featureInventory: FIXTURES.a.featureInventory,
        now: () => performance.now(),
        runWorkload,
      });
      const profile: ThreadViewerProfile = {
        viewer,
        markdownRenderer: 'satteri',
        messageCount: FIXTURES.a.messages.length,
        initialRowCount: visibleCount(),
        fixtureVersion: FIXTURES.fixtureVersion,
        fixtureChecksums: { a: FIXTURES.a.checksum, b: FIXTURES.b.checksum },
        featureInventory: FIXTURES.a.featureInventory,
        handleCommand: adapter.handleCommand,
        scrollSweep: async () => {
          const values = (await runScroll(false)).map((sample) => sample.value);
          const samples = values.length;
          const meanMs = values.reduce((total, sample) => total + sample, 0) / samples;
          return {
            meanMs,
            p95Ms: percentile(values, 95),
            maxMs: Math.max(...values),
            samples,
          };
        },
        switchThread: switchOnce,
      };
      window.funnyThreadProfile = profile;
      requiredElement('profile-status').textContent =
        `Ready: ${viewer} viewer, Sätteri markdown, ${FIXTURES.a.messages.length} messages`;
    };

    const waitForSatteri = () => {
      if (cancelled) return;
      if (!document.querySelector('[data-satteri-pending]')) {
        publishProfile();
        return;
      }
      frame = requestAnimationFrame(waitForSatteri);
    };

    frame = requestAnimationFrame(waitForSatteri);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [viewer]);

  const list =
    viewer === 'frozen' ? (
      <FrozenMessageList {...commonProps} />
    ) : (
      <MemoizedMessageList {...commonProps} />
    );

  return (
    <ThreadProvider threadId={fixture.threadId}>
      <TooltipProvider>
        <div
          ref={scrollRef}
          id="thread-profile-viewport"
          style={{ height: '720px', overflow: 'auto', border: '1px solid currentColor' }}
        >
          <div data-testid="benchmark-input-state">Input state revision {inputRevision}</div>
          {list}
        </div>
      </TooltipProvider>
    </ThreadProvider>
  );
}

createRoot(requiredElement('root')).render(<ThreadViewerFixture />);
