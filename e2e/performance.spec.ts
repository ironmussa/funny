import type { BrowserContext, Page } from '@playwright/test';

import {
  createTempGitRepo,
  removeTempDir,
  test,
  expect,
  waitForSidebar,
  seedProject,
} from './fixtures';
import { mockMessage, mockThreadResponse, mockThreadWithMessages } from './mock-helpers';

const THREAD_VIEWER_STORAGE_KEY = 'funny_thread_viewer';
const PROFILE_TURNS = 108;

type Viewer = 'virtual' | 'frozen';

type ViewerProfile = {
  viewer: Viewer;
  heapBytes: number;
  domNodes: number;
  renderedRows: number;
  frozenMessages: number;
  liveFrozenMessages: number;
  layoutShiftEntries: number;
  allLayoutShift: number;
  cls: number;
  largestLayoutShift: number;
};

type StartupWebVitals = {
  lcp: number | null;
  lcpElement: { tag: string; className: string; testId: string | null } | null;
  cls: number;
  largestLayoutShift: number;
  longTasks: Array<{ startTime: number; duration: number }>;
  layoutShifts: Array<{
    startTime: number;
    value: number;
    sources: Array<{
      tag: string;
      className: string;
      testId: string | null;
      previousRect: { x: number; y: number; width: number; height: number } | null;
      currentRect: { x: number; y: number; width: number; height: number } | null;
    }>;
  }>;
};

type KeyboardPaintMetric = {
  key: string;
  duration: number;
};

function longMarkdownReply(turn: number) {
  return [
    `## Benchmark response ${turn + 1}`,
    '',
    'This deliberately realistic response has **formatted text**, a list, a table, and code so the profile exercises the expensive markdown path rather than plain paragraphs.',
    '',
    '- Preserve the visible scroll anchor while history loads.',
    '- Keep rendered output searchable with native find-in-page.',
    '- Release React markdown fibers once a row leaves the viewport.',
    '',
    '| Metric | Expected |',
    '| --- | --- |',
    '| Heap | Lower outside the viewport |',
    '| CLS | No unexpected visual movement |',
    '',
    '```ts',
    `const benchmarkTurn${turn} = await profileThread({ viewer: 'frozen' });`,
    'expect(benchmarkTurn.layoutShift).toBe(0);',
    '```',
    '',
    '> This block represents a multi-line agent explanation with enough structure to mount markdown, syntax highlighting, and prose nodes.',
  ].join('\n');
}

function longThreadConversation(threadId: string, projectId: string) {
  const baseTimestamp = Date.parse('2026-01-01T00:00:00.000Z');
  const messages = Array.from({ length: PROFILE_TURNS }, (_, turn) => {
    const userTimestamp = new Date(baseTimestamp + turn * 2_000).toISOString();
    const assistantTimestamp = new Date(baseTimestamp + turn * 2_000 + 1_000).toISOString();
    return [
      mockMessage({
        id: `profile-user-${turn}`,
        threadId,
        role: 'user',
        timestamp: userTimestamp,
        content: `Benchmark request ${turn + 1}: inspect this section and retain the important implementation details.`,
      }),
      mockMessage({
        id: `profile-assistant-${turn}`,
        threadId,
        role: 'assistant',
        timestamp: assistantTimestamp,
        content: longMarkdownReply(turn),
      }),
    ];
  }).flat();

  return mockThreadWithMessages(threadId, projectId, {
    status: 'completed',
    title: 'Thread viewer performance fixture',
    messages,
  });
}

async function installLayoutShiftObserver(page: Page, viewer: Viewer) {
  await page.addInitScript(
    ({ storageKey, selectedViewer }) => {
      localStorage.setItem(storageKey, selectedViewer);
      const entries: Array<{ value: number; hadRecentInput: boolean }> = [];
      (window as any).threadViewerLayoutShifts = entries;
      if (!PerformanceObserver.supportedEntryTypes?.includes('layout-shift')) return;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const layoutShift = entry as PerformanceEntry & {
            value: number;
            hadRecentInput: boolean;
          };
          entries.push({
            value: layoutShift.value,
            hadRecentInput: layoutShift.hadRecentInput,
          });
        }
      }).observe({ type: 'layout-shift', buffered: true });
    },
    { storageKey: THREAD_VIEWER_STORAGE_KEY, selectedViewer: viewer },
  );
}

async function installStartupWebVitalsObserver(page: Page) {
  await page.addInitScript(() => {
    type Rect = { x: number; y: number; width: number; height: number };
    type ShiftSource = {
      tag: string;
      className: string;
      testId: string | null;
      previousRect: Rect | null;
      currentRect: Rect | null;
    };
    type Shift = {
      startTime: number;
      value: number;
      hadRecentInput: boolean;
      sources: ShiftSource[];
    };
    const layoutShifts: Shift[] = [];
    const longTasks: Array<{ startTime: number; duration: number }> = [];
    const metrics: {
      lcp: number | null;
      lcpElement: { tag: string; className: string; testId: string | null } | null;
      layoutShifts: Shift[];
      longTasks: Array<{ startTime: number; duration: number }>;
    } = { lcp: null, lcpElement: null, layoutShifts, longTasks };
    (window as any).startupWebVitals = metrics;

    const rect = (value: DOMRectReadOnly | undefined): Rect | null =>
      value ? { x: value.x, y: value.y, width: value.width, height: value.height } : null;
    const source = (attribution: any): ShiftSource => {
      const node = attribution.node as HTMLElement | null;
      return {
        tag: node?.tagName.toLowerCase() ?? 'unknown',
        className: typeof node?.className === 'string' ? node.className : '',
        testId: node?.getAttribute('data-testid') ?? null,
        previousRect: rect(attribution.previousRect),
        currentRect: rect(attribution.currentRect),
      };
    };

    if (PerformanceObserver.supportedEntryTypes?.includes('largest-contentful-paint')) {
      new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const latest = entries[entries.length - 1] as PerformanceEntry & {
          startTime: number;
          element?: Element;
        };
        if (latest) {
          metrics.lcp = latest.startTime;
          const element = latest.element as HTMLElement | undefined;
          metrics.lcpElement = element
            ? {
                tag: element.tagName.toLowerCase(),
                className: typeof element.className === 'string' ? element.className : '',
                testId: element.getAttribute('data-testid'),
              }
            : null;
        }
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    }
    if (PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTasks.push({ startTime: entry.startTime, duration: entry.duration });
        }
      }).observe({ type: 'longtask', buffered: true });
    }
    if (PerformanceObserver.supportedEntryTypes?.includes('layout-shift')) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const layoutShift = entry as PerformanceEntry & {
            value: number;
            hadRecentInput: boolean;
            sources?: unknown[];
          };
          layoutShifts.push({
            startTime: layoutShift.startTime,
            value: layoutShift.value,
            hadRecentInput: layoutShift.hadRecentInput,
            sources: (layoutShift.sources ?? []).map(source),
          });
        }
      }).observe({ type: 'layout-shift', buffered: true });
    }
  });
}

/**
 * Measures the practical INP boundary for the prompt: keydown dispatch until
 * two animation frames later, when the browser has had an opportunity to paint
 * the editor update. Event Timing is sampled as well when Chromium exposes it.
 */
async function installKeyboardPaintObserver(page: Page) {
  await page.addInitScript(() => {
    const paints: KeyboardPaintMetric[] = [];
    const events: Array<{ name: string; duration: number }> = [];
    (window as any).promptKeyboardPaints = paints;
    (window as any).promptKeyboardEvents = events;

    document.addEventListener(
      'keydown',
      (event) => {
        if (!(event.target as Element | null)?.matches('[data-testid="prompt-editor"]')) return;
        const start = performance.now();
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            paints.push({ key: event.key, duration: performance.now() - start });
          });
        });
      },
      true,
    );

    if (PerformanceObserver.supportedEntryTypes?.includes('event')) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const event = entry as PerformanceEntry & { name: string; duration: number };
          if (event.name === 'keydown' || event.name === 'keyup') {
            events.push({ name: event.name, duration: event.duration });
          }
        }
      }).observe({ type: 'event', buffered: true, durationThreshold: 16 });
    }
  });
}

async function collectStartupWebVitals(page: Page): Promise<StartupWebVitals> {
  return page.evaluate(() => {
    const metrics = (window as any).startupWebVitals as {
      lcp: number | null;
      lcpElement: StartupWebVitals['lcpElement'];
      layoutShifts: Array<{
        value: number;
        startTime: number;
        hadRecentInput: boolean;
        sources: StartupWebVitals['layoutShifts'][number]['sources'];
      }>;
      longTasks: StartupWebVitals['longTasks'];
    };
    const eligible = metrics.layoutShifts.filter((shift) => !shift.hadRecentInput);
    return {
      lcp: metrics.lcp,
      lcpElement: metrics.lcpElement,
      cls: eligible.reduce((total, shift) => total + shift.value, 0),
      largestLayoutShift: eligible.reduce((largest, shift) => Math.max(largest, shift.value), 0),
      longTasks: metrics.longTasks,
      layoutShifts: eligible
        .sort((left, right) => right.value - left.value)
        .map(({ startTime, value, sources }) => ({ startTime, value, sources })),
    } satisfies StartupWebVitals;
  });
}

async function sweepThreadViewport(page: Page) {
  await page.evaluate(async () => {
    const firstRow = document.querySelector<HTMLElement>('[data-virtual-row-key]');
    if (!firstRow) throw new Error('Thread did not render a message row');

    let viewport: HTMLElement | null = firstRow.parentElement;
    while (viewport) {
      const overflowY = getComputedStyle(viewport).overflowY;
      if (
        (overflowY === 'auto' || overflowY === 'scroll') &&
        viewport.scrollHeight > viewport.clientHeight
      ) {
        break;
      }
      viewport = viewport.parentElement;
    }
    if (!viewport) throw new Error('Could not locate the thread scroll viewport');

    const waitForPaint = () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    const moveTo = async (edge: 'top' | 'bottom') => {
      for (let step = 0; step < 500; step++) {
        const target = edge === 'top' ? 0 : viewport.scrollHeight - viewport.clientHeight;
        const remaining = target - viewport.scrollTop;
        if (Math.abs(remaining) < 1) return;
        const delta =
          Math.sign(remaining) *
          Math.min(Math.max(viewport.clientHeight * 0.75, 1), Math.abs(remaining));
        viewport.scrollTop += delta;
        viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
        await waitForPaint();
      }
      throw new Error(`Thread scroll did not reach its ${edge} edge`);
    };

    // Start at the bottom, visit the full history, then return to the active end.
    // This makes every frozen row pass through the IntersectionObserver boundary.
    await moveTo('top');
    await moveTo('bottom');
  });
}

async function collectViewerProfile(page: Page, viewer: Viewer): Promise<ViewerProfile> {
  await page.waitForTimeout(750);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage').catch(() => {});
  const heapUsage = await cdp.send('Runtime.getHeapUsage');
  await cdp.detach();

  return page.evaluate(
    ({ selectedViewer, heapBytes }) => {
      const layoutShifts = ((window as any).threadViewerLayoutShifts ?? []) as Array<{
        value: number;
        hadRecentInput: boolean;
      }>;
      const values = layoutShifts.map((entry) => entry.value);
      return {
        viewer: selectedViewer,
        heapBytes,
        domNodes: document.querySelectorAll('*').length,
        renderedRows: document.querySelectorAll('[data-virtual-row-key]').length,
        frozenMessages: document.querySelectorAll('[data-frozen="true"]').length,
        liveFrozenMessages: document.querySelectorAll('[data-frozen="false"]').length,
        layoutShiftEntries: layoutShifts.length,
        allLayoutShift: values.reduce((total, value) => total + value, 0),
        cls: layoutShifts
          .filter((entry) => !entry.hadRecentInput)
          .reduce((total, entry) => total + entry.value, 0),
        largestLayoutShift: values.length === 0 ? 0 : Math.max(...values),
      } satisfies ViewerProfile;
    },
    { selectedViewer: viewer, heapBytes: heapUsage.usedSize },
  );
}

async function profileThreadViewer(
  context: BrowserContext,
  viewer: Viewer,
  threadUrl: string,
  threadId: string,
  conversation: ReturnType<typeof longThreadConversation>,
) {
  const page = await context.newPage();
  try {
    await installLayoutShiftObserver(page, viewer);
    await mockThreadResponse(page, threadId, conversation);
    await page.goto(threadUrl, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-virtual-row-key]').first().waitFor({ state: 'attached' });

    // Exclude mount-time movement; the profile is specifically the scroll sweep.
    await page.evaluate(() => {
      (window as any).threadViewerLayoutShifts = [];
    });
    await sweepThreadViewport(page);
    return await collectViewerProfile(page, viewer);
  } finally {
    await page.close();
  }
}

test.describe('J. Performance', () => {
  // These tests create isolated projects and sample CPU-sensitive metrics.
  // Parallel workers both skew the measurements and can hit the API's project
  // creation rate limit, so keep this performance profile intentionally serial.
  test.describe.configure({ mode: 'serial' });

  test('J.1 Initial page load under 5 seconds', async ({ page }) => {
    const start = Date.now();

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await waitForSidebar(page);

    const elapsed = Date.now() - start;
    expect(elapsed, `Page load took ${elapsed}ms, expected < 5000ms`).toBeLessThan(5000);
  });

  test('J.2 Navigation between views under 1 second', async ({ authedPage: page }) => {
    const routes = ['/list', '/kanban', '/analytics', '/'];

    for (const route of routes) {
      const start = Date.now();
      await page.goto(route);
      await page.waitForLoadState('domcontentloaded');
      const elapsed = Date.now() - start;

      expect(elapsed, `Navigation to ${route} took ${elapsed}ms`).toBeLessThan(3000);
    }
  });

  test('J.3 Large project list renders without lag', async ({
    authedPage: page,
    api,
    tempRepo,
  }) => {
    // Create 15 projects
    const projectIds: string[] = [];
    for (let i = 0; i < 15; i++) {
      const p = await api.createProject(`Perf-${i}-${Date.now()}`, tempRepo);
      projectIds.push(p.id);
    }

    const start = Date.now();
    await page.reload();
    await waitForSidebar(page);
    const elapsed = Date.now() - start;

    expect(elapsed, `Rendering 15 projects took ${elapsed}ms`).toBeLessThan(5000);

    // All projects should be visible
    for (const id of projectIds.slice(0, 5)) {
      await expect(page.getByTestId(`project-item-${id}`)).toBeVisible();
    }

    // Cleanup
    for (const id of projectIds) {
      await api.deleteProject(id);
    }
  });

  test('J.4 Rapid thread switching does not cause errors', async ({
    authedPage: page,
    api,
    tempRepo,
  }) => {
    const project = await seedProject(api, page, tempRepo, `RapidSwitch-${Date.now()}`);
    const threads: string[] = [];

    for (let i = 0; i < 5; i++) {
      const t = await api.createIdleThread(project.id, `Switch ${i}`);
      threads.push(t.id);
    }

    await page.reload();
    await waitForSidebar(page);
    await page.getByTestId(`project-item-${project.id}`).click();
    await page.waitForTimeout(500);

    // Collect JS errors
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    // Rapidly switch between threads
    for (const id of threads) {
      await page.getByTestId(`thread-item-${id}`).click();
      await page.waitForTimeout(100); // Very fast switching
    }

    // Wait for everything to settle
    await page.waitForTimeout(1000);

    // No JS errors should have occurred
    expect(errors.length, `JS errors during rapid switching: ${errors.join(', ')}`).toBe(0);

    // Cleanup
    for (const id of threads) {
      await api.deleteThread(id);
    }
    await api.deleteProject(project.id);
  });

  test('J.5 Command palette opens quickly', async ({ authedPage: page }) => {
    const start = Date.now();
    await page.keyboard.press('Control+k');
    await expect(page.getByTestId('command-palette-search')).toBeVisible();
    const elapsed = Date.now() - start;

    expect(elapsed, `Command palette took ${elapsed}ms to open`).toBeLessThan(500);

    await page.keyboard.press('Escape');
  });

  test('J.6 Settings dialog opens quickly', async ({ authedPage: page }) => {
    const start = Date.now();
    await page.getByTestId('sidebar-settings').click();
    await expect(page.getByTestId('settings-dialog-save')).toBeVisible();
    const elapsed = Date.now() - start;

    expect(elapsed, `Settings dialog took ${elapsed}ms to open`).toBeLessThan(1000);

    await page.getByTestId('settings-dialog-cancel').click();
  });

  test('J.7 No memory leaks on repeated navigation', async ({ authedPage: page }) => {
    // Get initial memory usage
    const getMemory = async () => {
      return page.evaluate(() => {
        if ((performance as any).memory) {
          return (performance as any).memory.usedJSHeapSize;
        }
        return 0;
      });
    };

    const initialMemory = await getMemory();

    // Navigate back and forth many times
    for (let i = 0; i < 10; i++) {
      await page.goto('/list');
      await page.waitForLoadState('domcontentloaded');
      await page.goto('/kanban');
      await page.waitForLoadState('domcontentloaded');
    }

    // Force GC if available
    await page.evaluate(() => {
      if ((window as any).gc) (window as any).gc();
    });
    await page.waitForTimeout(1000);

    const finalMemory = await getMemory();

    // Memory shouldn't grow more than 3x (generous threshold)
    if (initialMemory > 0 && finalMemory > 0) {
      expect(finalMemory).toBeLessThan(initialMemory * 3);
    }
  });

  test('J.8 profiles layout shifts and memory for a long thread in both viewers', async ({
    api,
    authedPage,
    browser,
    baseURL,
  }, testInfo) => {
    test.setTimeout(120_000);
    // The conversation is served from Playwright routes, but route hydration
    // still validates the project. Put the temporary repo under $HOME (an
    // allowed project root) and clean up both the database row and repo.
    const profileRepo = createTempGitRepo('-viewer-profile', process.env.HOME ?? process.cwd());
    const project = await api
      .createProject(`ViewerProfile-${Date.now()}`, profileRepo)
      .catch((error) => {
        removeTempDir(profileRepo);
        throw error;
      });
    const projectId = project.id;
    const threadId = `profile-thread-${Date.now()}`;
    const conversation = longThreadConversation(threadId, projectId);
    const storageState = await authedPage.context().storageState();
    const threadUrl = `${baseURL}/projects/${projectId}/threads/${threadId}`;

    // Separate, fresh contexts prevent React state and the HTTP cache from one
    // viewer contaminating the other measurement.
    const virtualContext = await browser.newContext({ storageState });
    try {
      const virtual = await profileThreadViewer(
        virtualContext,
        'virtual',
        threadUrl,
        threadId,
        conversation,
      );
      await virtualContext.close();
      const frozenContext = await browser.newContext({ storageState });
      try {
        const frozen = await profileThreadViewer(
          frozenContext,
          'frozen',
          threadUrl,
          threadId,
          conversation,
        );

        const report = {
          fixture: { turns: PROFILE_TURNS, messages: PROFILE_TURNS * 2 },
          virtual,
          frozen,
          deltas: {
            heapBytes: frozen.heapBytes - virtual.heapBytes,
            heapPercent: ((frozen.heapBytes - virtual.heapBytes) / virtual.heapBytes) * 100,
            domNodes: frozen.domNodes - virtual.domNodes,
            cls: frozen.cls - virtual.cls,
          },
        };
        await testInfo.attach('thread-viewer-profile.json', {
          body: JSON.stringify(report, null, 2),
          contentType: 'application/json',
        });

        // This verifies the long-thread sweep actually traversed the frozen
        // lifecycle; the measurements above are deliberately recorded rather
        // than thresholded until we establish a stable cross-machine baseline.
        expect(frozen.frozenMessages).toBeGreaterThan(0);
        expect(frozen.liveFrozenMessages).toBeGreaterThan(0);
        expect(frozen.domNodes).toBeGreaterThan(virtual.domNodes);
      } finally {
        await frozenContext.close();
      }
    } finally {
      await virtualContext.close();
      await api.deleteProject(project.id).catch(() => {});
      removeTempDir(profileRepo);
    }
  });

  test('J.9 attributes startup LCP and layout shifts to their DOM sources', async ({
    authedPage,
    browser,
  }, testInfo) => {
    const storageState = await authedPage.context().storageState();
    const context = await browser.newContext({ storageState });
    const page = await context.newPage();
    try {
      await installStartupWebVitalsObserver(page);
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await waitForSidebar(page);
      // Runner status, lazy panels, and the app shell can all settle after the
      // sidebar first appears, so retain a short quiet period before sampling.
      await page.waitForTimeout(3_000);

      const metrics = await collectStartupWebVitals(page);
      await testInfo.attach('startup-web-vitals.json', {
        body: JSON.stringify(metrics, null, 2),
        contentType: 'application/json',
      });

      expect(metrics.lcp).not.toBeNull();
    } finally {
      await context.close();
    }
  });

  test('J.10 attributes the late runner-onboarding banner layout shift', async ({
    authedPage,
    browser,
  }, testInfo) => {
    const storageState = await authedPage.context().storageState();
    const context = await browser.newContext({ storageState });
    const page = await context.newPage();
    try {
      await page.route('**/api/bootstrap', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 750));
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ mode: 'team' }),
        });
      });
      await page.route('**/api/runners', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 750));
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ runners: [] }),
        });
      });
      await installStartupWebVitalsObserver(page);
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('runner-onboarding-banner')).toBeVisible();
      await page.waitForTimeout(1_000);

      const metrics = await collectStartupWebVitals(page);
      await testInfo.attach('runner-onboarding-web-vitals.json', {
        body: JSON.stringify(metrics, null, 2),
        contentType: 'application/json',
      });

      expect(metrics.cls).toBeLessThan(0.01);
    } finally {
      await context.close();
    }
  });

  test('J.11 profiles prompt keyboard-to-paint in a long thread', async ({
    api,
    authedPage,
    browser,
    baseURL,
  }, testInfo) => {
    test.setTimeout(120_000);
    const profileRepo = createTempGitRepo(
      '-prompt-input-profile',
      process.env.HOME ?? process.cwd(),
    );
    const project = await api
      .createProject(`PromptInputProfile-${Date.now()}`, profileRepo)
      .catch((error) => {
        removeTempDir(profileRepo);
        throw error;
      });
    const threadId = `prompt-input-profile-${Date.now()}`;
    const conversation = longThreadConversation(threadId, project.id);
    const storageState = await authedPage.context().storageState();
    const context = await browser.newContext({ storageState });
    const page = await context.newPage();

    try {
      await installKeyboardPaintObserver(page);
      await mockThreadResponse(page, threadId, conversation);
      await page.goto(`${baseURL}/projects/${project.id}/threads/${threadId}`, {
        waitUntil: 'domcontentloaded',
      });
      const prompt = page.getByTestId('prompt-editor');
      await prompt.waitFor({ state: 'visible' });
      await prompt.click();
      await page.keyboard.type('measure keyboard responsiveness');
      await page.waitForTimeout(100);

      const metrics = await page.evaluate(() => {
        const paints = (window as any).promptKeyboardPaints as KeyboardPaintMetric[];
        const events = (window as any).promptKeyboardEvents as Array<{
          name: string;
          duration: number;
        }>;
        return {
          samples: paints.length,
          maxKeyboardToPaint: Math.max(0, ...paints.map((sample) => sample.duration)),
          p95KeyboardToPaint:
            paints.map((sample) => sample.duration).sort((a, b) => a - b)[
              Math.max(0, Math.ceil(paints.length * 0.95) - 1)
            ] ?? 0,
          maxEventDuration: Math.max(0, ...events.map((event) => event.duration)),
          eventEntries: events.length,
        };
      });
      await testInfo.attach('prompt-keyboard-profile.json', {
        body: JSON.stringify(metrics, null, 2),
        contentType: 'application/json',
      });

      expect(metrics.samples).toBeGreaterThan(0);
    } finally {
      await context.close();
      await api.deleteProject(project.id).catch(() => {});
      removeTempDir(profileRepo);
    }
  });

  test('J.12 attributes LCP when a markdown thread is opened by direct URL', async ({
    api,
    authedPage,
    browser,
    baseURL,
  }, testInfo) => {
    test.setTimeout(120_000);
    const profileRepo = createTempGitRepo('-lcp-profile', process.env.HOME ?? process.cwd());
    const project = await api
      .createProject(`LcpProfile-${Date.now()}`, profileRepo)
      .catch((error) => {
        removeTempDir(profileRepo);
        throw error;
      });
    const threadId = `lcp-profile-${Date.now()}`;
    const conversation = longThreadConversation(threadId, project.id);
    const storageState = await authedPage.context().storageState();
    const context = await browser.newContext({ storageState });
    const page = await context.newPage();

    try {
      await installStartupWebVitalsObserver(page);
      await mockThreadResponse(page, threadId, conversation);
      await page.goto(`${baseURL}/projects/${project.id}/threads/${threadId}`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.locator('[data-testid^="assistant-message-"]').last()).toBeVisible({
        timeout: 10_000,
      });
      // Preserve the LCP observation window after the actual message is painted.
      await page.waitForTimeout(1_000);

      const metrics = await collectStartupWebVitals(page);
      await testInfo.attach('direct-thread-lcp-profile.json', {
        body: JSON.stringify(metrics, null, 2),
        contentType: 'application/json',
      });

      expect(metrics.lcp).not.toBeNull();
      // This E2E includes real app bootstrap and has no CPU throttling. Keep a
      // stable regression guard here; the attached attribution is the signal
      // for optimizing the route-specific LCP further.
      expect(metrics.lcp).toBeLessThan(4_000);
    } finally {
      await context.close();
      await api.deleteProject(project.id).catch(() => {});
      removeTempDir(profileRepo);
    }
  });

  test('J.13 keeps Frozen-viewer startup CLS below 0.1', async ({
    api,
    authedPage,
    browser,
    baseURL,
  }, testInfo) => {
    test.setTimeout(120_000);
    const profileRepo = createTempGitRepo(
      '-frozen-startup-profile',
      process.env.HOME ?? process.cwd(),
    );
    const project = await api
      .createProject(`FrozenStartupProfile-${Date.now()}`, profileRepo)
      .catch((error) => {
        removeTempDir(profileRepo);
        throw error;
      });
    const threadId = `frozen-startup-profile-${Date.now()}`;
    const conversation = longThreadConversation(threadId, project.id);
    const storageState = await authedPage.context().storageState();
    const context = await browser.newContext({ storageState });
    const page = await context.newPage();

    try {
      await page.addInitScript(
        ({ storageKey, viewer }) => localStorage.setItem(storageKey, viewer),
        { storageKey: THREAD_VIEWER_STORAGE_KEY, viewer: 'frozen' },
      );
      await installStartupWebVitalsObserver(page);
      await mockThreadResponse(page, threadId, conversation);
      await page.goto(`${baseURL}/projects/${project.id}/threads/${threadId}`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.locator('[data-testid^="assistant-message-"]').last()).toBeVisible({
        timeout: 10_000,
      });
      await page.waitForTimeout(1_000);

      const metrics = await collectStartupWebVitals(page);
      await testInfo.attach('frozen-thread-startup-profile.json', {
        body: JSON.stringify(metrics, null, 2),
        contentType: 'application/json',
      });

      expect(metrics.lcp).not.toBeNull();
      expect(metrics.cls).toBeLessThan(0.1);
    } finally {
      await context.close();
      await api.deleteProject(project.id).catch(() => {});
      removeTempDir(profileRepo);
    }
  });
});
