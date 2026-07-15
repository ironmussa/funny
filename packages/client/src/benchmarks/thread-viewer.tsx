import { useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

import { FrozenMessageList } from '@/components/thread/FrozenMessageList';
import { MemoizedMessageList } from '@/components/thread/MemoizedMessageList';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ThreadProvider } from '@/stores/thread-context';
import { makeLongThread } from '@/test-fixtures/long-thread-fixture';

import '../globals.css';
import '../i18n/config';

type Viewer = 'virtual' | 'frozen';

export interface ThreadViewerProfile {
  viewer: Viewer;
  markdownRenderer: 'satteri';
  messageCount: number;
  initialRowCount: number;
  scrollSweep: () => Promise<{ meanMs: number; p95Ms: number; maxMs: number; samples: number }>;
  switchThread: () => Promise<number>;
}

declare global {
  interface Window {
    funnyThreadProfile?: ThreadViewerProfile;
  }
}

const FIXTURES = {
  a: makeLongThread({ messageCount: 500, seed: 1, threadId: 'profile-a', toolCallRatio: 0.5 }),
  b: makeLongThread({ messageCount: 500, seed: 2, threadId: 'profile-b', toolCallRatio: 0.5 }),
};

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

function ThreadViewerFixture() {
  const viewer = getViewer();
  const [fixtureKey, setFixtureKey] = useState<keyof typeof FIXTURES>('a');
  const scrollRef = useRef<HTMLDivElement>(null);
  const fixture = FIXTURES[fixtureKey];
  const commonProps = useMemo(
    () => ({
      messages: fixture.messages,
      threadId: fixture.threadId,
      threadStatus: 'idle',
      knownIds: new Set<string>(),
      snapshotMap: new Map<string, number>(),
      onSend: () => {},
      onOpenLightbox: () => {},
      scrollRef,
    }),
    [fixture],
  );

  useEffect(() => {
    let cancelled = false;
    let frame = 0;
    const publishProfile = () => {
      if (cancelled) return;
      window.funnyThreadProfile = {
        viewer,
        markdownRenderer: 'satteri',
        messageCount: fixture.messages.length,
        initialRowCount: document.querySelectorAll('[data-virtual-row-key]').length,
        scrollSweep: async () => {
          const viewport = scrollRef.current;
          if (!viewport) throw new Error('Thread profile viewport is unavailable');

          viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
          await nextFrame();
          const maxScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
          const samples: number[] = [];
          for (let step = 0; step <= 40; step++) {
            const start = performance.now();
            viewport.scrollTop = (maxScroll * step) / 40;
            viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
            await nextFrame();
            samples.push(performance.now() - start);
          }
          const meanMs = samples.reduce((total, sample) => total + sample, 0) / samples.length;
          return {
            meanMs,
            p95Ms: percentile(samples, 95),
            maxMs: Math.max(...samples),
            samples: samples.length,
          };
        },
        switchThread: async () => {
          const start = performance.now();
          flushSync(() => setFixtureKey((current) => (current === 'a' ? 'b' : 'a')));
          await nextFrame();
          await nextFrame();
          return performance.now() - start;
        },
      };
      requiredElement('profile-status').textContent =
        `Ready: ${viewer} viewer, Sätteri markdown, ${fixture.messages.length} messages`;
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
  }, [fixture, viewer]);

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
          {list}
        </div>
      </TooltipProvider>
    </ThreadProvider>
  );
}

createRoot(requiredElement('root')).render(<ThreadViewerFixture />);
