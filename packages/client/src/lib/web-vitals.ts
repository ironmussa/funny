import { createClientLogger } from './client-logger';
import { metric } from './telemetry';

const log = createClientLogger('web-vitals');

interface LcpEntry extends PerformanceEntry {
  renderTime: number;
  loadTime: number;
  size: number;
  element?: Element | null;
  url?: string;
}

interface LayoutShiftEntry extends PerformanceEntry {
  value: number;
  hadRecentInput: boolean;
  sources?: Array<{ node?: Node | null }>;
}

interface EventTimingEntry extends PerformanceEntry {
  interactionId?: number;
  processingStart: number;
  processingEnd: number;
  target?: Element | null;
}

function describeElement(el: Element | null | undefined): Record<string, string> {
  if (!el) return {};
  const tag = el.tagName?.toLowerCase() ?? 'unknown';
  const id = el.id ? `#${el.id}` : '';
  const cls =
    typeof el.className === 'string' && el.className
      ? '.' + el.className.trim().split(/\s+/).slice(0, 4).join('.')
      : '';
  const text = (el.textContent ?? '').trim().slice(0, 80);
  return {
    'lcp.element.tag': tag,
    'lcp.element.selector': `${tag}${id}${cls}`.slice(0, 200),
    ...(text ? { 'lcp.element.text': text } : {}),
  };
}

function reportLcp(entry: LcpEntry) {
  const value = entry.renderTime || entry.loadTime || entry.startTime;
  const attrs = {
    ...describeElement(entry.element),
    ...(entry.url ? { 'lcp.url': entry.url } : {}),
    'lcp.size': String(Math.round(entry.size)),
  };
  metric('web_vitals.lcp.ms', value, { type: 'gauge', attributes: attrs });
  log.debug({ valueMs: Math.round(value), ...attrs }, 'LCP candidate');
}

function reportPaint(entry: PerformanceEntry) {
  if (entry.name === 'first-contentful-paint') {
    metric('web_vitals.fcp.ms', entry.startTime, { type: 'gauge' });
  }
}

function reportTtfb() {
  const nav = performance.getEntriesByType('navigation')[0] as
    | PerformanceNavigationTiming
    | undefined;
  if (!nav) return;
  const ttfb = nav.responseStart - nav.startTime;
  if (ttfb > 0) metric('web_vitals.ttfb.ms', ttfb, { type: 'gauge' });
}

function startCls() {
  let sessionValue = 0;
  let sessionEntries: LayoutShiftEntry[] = [];
  let max = 0;
  let maxSources: Array<{ node?: Node | null }> = [];

  const finalize = () => {
    if (max <= 0) return;
    const topSel = maxSources
      .map((s) =>
        s.node instanceof Element ? describeElement(s.node)['lcp.element.selector'] : '',
      )
      .filter(Boolean)
      .slice(0, 3)
      .join(' | ');
    metric('web_vitals.cls', max, {
      type: 'gauge',
      attributes: topSel ? { 'cls.sources': topSel } : undefined,
    });
  };

  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries() as LayoutShiftEntry[]) {
        if (e.hadRecentInput) continue;
        const first = sessionEntries[0];
        const last = sessionEntries[sessionEntries.length - 1];
        if (last && (e.startTime - last.startTime > 1000 || e.startTime - first.startTime > 5000)) {
          sessionValue = e.value;
          sessionEntries = [e];
        } else {
          sessionValue += e.value;
          sessionEntries.push(e);
        }
        if (sessionValue > max) {
          max = sessionValue;
          maxSources = e.sources ?? [];
        }
      }
    });
    po.observe({ type: 'layout-shift', buffered: true });
  } catch {
    return;
  }

  addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') finalize();
  });
  addEventListener('pagehide', finalize);
}

function startInp() {
  let max = 0;
  let maxEntry: EventTimingEntry | null = null;

  const finalize = () => {
    if (max <= 0) return;
    const targetAttrs = maxEntry?.target instanceof Element ? describeElement(maxEntry.target) : {};
    metric('web_vitals.inp.ms', max, {
      type: 'gauge',
      attributes: {
        ...(maxEntry ? { 'inp.event': maxEntry.name } : {}),
        ...(targetAttrs['lcp.element.selector']
          ? { 'inp.target': targetAttrs['lcp.element.selector'] }
          : {}),
      },
    });
  };

  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries() as EventTimingEntry[]) {
        if (e.interactionId && e.duration > max) {
          max = e.duration;
          maxEntry = e;
        }
      }
    });
    po.observe({ type: 'event', buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
  } catch {
    return;
  }

  addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') finalize();
  });
  addEventListener('pagehide', finalize);
}

function startLcp() {
  let last: LcpEntry | null = null;

  const finalize = () => {
    if (last) {
      const value = last.renderTime || last.loadTime || last.startTime;
      metric('web_vitals.lcp.final.ms', value, {
        type: 'gauge',
        attributes: describeElement(last.element),
      });
    }
  };

  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries() as LcpEntry[]) {
        last = e;
        reportLcp(e);
      }
    });
    po.observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {
    return;
  }

  // LCP is finalized on the first user input or on page hide.
  const stopOnInput = () => {
    finalize();
    removeEventListener('keydown', stopOnInput, true);
    removeEventListener('pointerdown', stopOnInput, true);
  };
  addEventListener('keydown', stopOnInput, true);
  addEventListener('pointerdown', stopOnInput, true);
  addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') finalize();
  });
  addEventListener('pagehide', finalize);
}

function startPaint() {
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) reportPaint(e);
    });
    po.observe({ type: 'paint', buffered: true });
  } catch {
    /* unsupported */
  }
}

let started = false;
export function initWebVitals(): void {
  if (started) return;
  started = true;
  if (typeof PerformanceObserver === 'undefined') return;
  reportTtfb();
  startPaint();
  startLcp();
  startCls();
  startInp();
}
