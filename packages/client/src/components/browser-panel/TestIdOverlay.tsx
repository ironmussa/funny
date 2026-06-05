import { useEffect, useState } from 'react';

import { browserSessionClient } from '@/lib/browser-session-client';
import {
  BROWSER_SESSION_VIEWPORT_HEIGHT as VIEWPORT_H,
  BROWSER_SESSION_VIEWPORT_WIDTH as VIEWPORT_W,
} from '@/lib/browser-session-viewport';
import { createClientLogger } from '@/lib/client-logger';
import { useBrowserPanelStore } from '@/stores/browser-panel-store';

const REFRESH_MS = 2000;

const log = createClientLogger('browser-session');

interface TestIdLabel {
  testid: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const COLLECT_TESTIDS_EXPR = `
(() => {
  const out = [];
  const els = document.querySelectorAll('[data-testid]');
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
    out.push({
      testid: el.getAttribute('data-testid'),
      x: Math.round(r.x), y: Math.round(r.y),
      w: Math.round(r.width), h: Math.round(r.height),
    });
  }
  return out;
})()
`.trim();

/**
 * When `showTestIds` is on, queries the headless Chromium page for every
 * `[data-testid]` element via CDP and renders a label badge over each one.
 * Refreshes every 2 seconds so labels keep up with SPA route changes.
 */
export function TestIdOverlay() {
  const showTestIds = useBrowserPanelStore((s) => s.showTestIds);
  const sessionId = useBrowserPanelStore((s) => s.sessionId);
  const [labels, setLabels] = useState<TestIdLabel[]>([]);

  useEffect(() => {
    if (!showTestIds || !sessionId) {
      setLabels([]);
      return;
    }

    let cancelled = false;

    const refresh = async () => {
      try {
        const result = await browserSessionClient.execute(sessionId, COLLECT_TESTIDS_EXPR);
        if (!cancelled && Array.isArray(result)) {
          setLabels(result as TestIdLabel[]);
        }
      } catch (err) {
        log.debug('testid collect failed', { error: String(err) });
      }
    };

    refresh();
    const id = setInterval(refresh, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [showTestIds, sessionId]);

  if (!showTestIds) return null;

  return (
    <div
      data-testid="browser-panel-testid-overlay"
      className="pointer-events-none absolute inset-0"
    >
      {labels.map((label, i) => {
        const left = `${(label.x / VIEWPORT_W) * 100}%`;
        const top = `${(label.y / VIEWPORT_H) * 100}%`;
        const width = `${(label.w / VIEWPORT_W) * 100}%`;
        const height = `${(label.h / VIEWPORT_H) * 100}%`;
        return (
          <div
            key={`${label.testid}-${i}`}
            className="border-primary/70 absolute border"
            style={{ left, top, width, height }}
          >
            <span
              className="bg-primary text-primary-foreground absolute -top-4 right-0 rounded-sm px-1.5 py-0.5 text-[10px] font-medium"
              style={{ whiteSpace: 'nowrap' }}
            >
              {label.testid}
            </span>
          </div>
        );
      })}
    </div>
  );
}
