import type { Page } from '@playwright/test';

import { expect, seedProject, test } from './fixtures';
import {
  injectSocketIOEvent,
  mockMessage,
  mockPaginatedThreadResponse,
  mockThreadWithMessages,
  setupWSIntercept,
} from './mock-helpers';

const THREAD_VIEWER_STORAGE_KEY = 'funny_thread_viewer';
const TOTAL_MESSAGES = 500;
const WINDOW_SIZE = 50;

function longThreadMessages(threadId: string) {
  const start = Date.parse('2026-01-01T00:00:00.000Z');
  return Array.from({ length: TOTAL_MESSAGES }, (_, index) =>
    mockMessage({
      id: `history-message-${index}`,
      threadId,
      role: index % 2 === 0 ? 'user' : 'assistant',
      timestamp: new Date(start + index * 1_000).toISOString(),
      content:
        index % 2 === 0
          ? `History request ${index}: preserve the reading position.`
          : `history-marker-${index} — rendered Markdown reply ${index} with **formatting** and a table.`,
    }),
  );
}

async function setFrozenViewer(page: Page) {
  await page.addInitScript(
    (storageKey) => localStorage.setItem(storageKey, 'frozen'),
    THREAD_VIEWER_STORAGE_KEY,
  );
}

async function scrollToEdge(page: Page, edge: 'top' | 'bottom') {
  await page.evaluate(async (target) => {
    const list = document.querySelector<HTMLElement>('[data-testid="frozen-message-list"]');
    if (!list) throw new Error('Frozen message list did not render');

    let viewport: HTMLElement | null = list.parentElement;
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
    if (!viewport) throw new Error('Thread scroll viewport was not found');

    viewport.scrollTop = target === 'top' ? 0 : viewport.scrollHeight;
    viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  }, edge);
}

async function scrollToProgress(page: Page, progress: number) {
  await page.evaluate(async (nextProgress) => {
    const list = document.querySelector<HTMLElement>('[data-testid="frozen-message-list"]');
    if (!list) throw new Error('Frozen message list did not render');

    let viewport: HTMLElement | null = list.parentElement;
    while (viewport) {
      const overflowY = getComputedStyle(viewport).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll') break;
      viewport = viewport.parentElement;
    }
    if (!viewport) throw new Error('Thread scroll viewport was not found');

    viewport.scrollTop = (viewport.scrollHeight - viewport.clientHeight) * nextProgress;
    viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  }, progress);
}

async function scrollMetrics(page: Page) {
  return page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('[data-testid="frozen-message-list"]');
    if (!list) throw new Error('Frozen message list did not render');

    let viewport: HTMLElement | null = list.parentElement;
    while (viewport) {
      const overflowY = getComputedStyle(viewport).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll') break;
      viewport = viewport.parentElement;
    }
    if (!viewport) throw new Error('Thread scroll viewport was not found');

    return {
      distanceFromBottom: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
      scrollTop: viewport.scrollTop,
    };
  });
}

async function streamAssistantMessage(
  page: Page,
  threadId: string,
  messageId: string,
  content: string,
) {
  await injectSocketIOEvent(page, {
    type: 'agent:message',
    threadId,
    data: { messageId, role: 'assistant', content },
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}

async function loadHistoryFromBothEdges(page: Page) {
  for (let attempt = 0; attempt < 16; attempt++) {
    await scrollToEdge(page, attempt % 2 === 0 ? 'top' : 'bottom');
    await page.waitForTimeout(120);
    const loadedRows = await page.locator('[data-virtual-row-key]').count();
    if (loadedRows >= TOTAL_MESSAGES) return;
  }
}

async function visibleAnchor(page: Page) {
  return page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('[data-testid="frozen-message-list"]');
    if (!list) throw new Error('Frozen message list did not render');

    let viewport: HTMLElement | null = list.parentElement;
    while (viewport) {
      const overflowY = getComputedStyle(viewport).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll') break;
      viewport = viewport.parentElement;
    }
    if (!viewport) throw new Error('Thread scroll viewport was not found');

    const viewportTop = viewport.getBoundingClientRect().top;
    const row = [...list.querySelectorAll<HTMLElement>('[data-virtual-row-key]')].find(
      (candidate) => candidate.getBoundingClientRect().bottom > viewportTop,
    );
    if (!row?.dataset.virtualRowKey) throw new Error('No visible message row');
    return {
      key: row.dataset.virtualRowKey,
      offset: row.getBoundingClientRect().top - viewportTop,
    };
  });
}

test.describe('J.14 Long thread history (500 messages)', () => {
  test('loads both directions, restores the reading anchor, and keeps offscreen text findable', async ({
    api,
    authedPage: page,
    baseURL,
    tempRepo,
  }) => {
    test.setTimeout(120_000);
    const project = await seedProject(api, page, tempRepo, `LongHistory-${Date.now()}`);
    const historyThread = await api.createIdleThread(project.id, 'Long history');
    const alternateThread = await api.createIdleThread(project.id, 'Alternate history');
    const historyMessages = longThreadMessages(historyThread.id);
    const alternateMessages = longThreadMessages(alternateThread.id).slice(0, 2);
    const history = mockThreadWithMessages(historyThread.id, project.id, {
      title: 'Long history',
      messages: historyMessages.slice(225, 225 + WINDOW_SIZE),
    });
    const alternate = mockThreadWithMessages(alternateThread.id, project.id, {
      title: 'Alternate history',
      messages: alternateMessages,
    });
    const paginationDirections = new Set<string>();
    const errors: string[] = [];

    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === `/api/threads/${historyThread.id}/messages`) {
        paginationDirections.add(url.searchParams.get('direction') ?? 'before');
      }
    });

    // The socket event injector must wrap the client connection before the
    // app creates it. Keep the authenticated context, then start a fresh page.
    await setupWSIntercept(page);
    await page.goto('about:blank');
    await setFrozenViewer(page);
    await mockPaginatedThreadResponse(page, historyThread.id, history, historyMessages, {
      initialWindowStart: 225,
      initialWindowSize: WINDOW_SIZE,
    });
    await mockPaginatedThreadResponse(page, alternateThread.id, alternate, alternateMessages);

    try {
      await page.goto(`${baseURL}/projects/${project.id}/threads/${historyThread.id}`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.getByTestId('frozen-message-list')).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              ((window as any).__playwright_ws_instances as WebSocket[] | undefined)?.some(
                (ws) => ws.readyState === WebSocket.OPEN && ws.url.includes('/socket.io/'),
              ) ?? false,
          ),
        )
        .toBe(true);

      await loadHistoryFromBothEdges(page);
      await expect
        .poll(() => page.locator('[data-virtual-row-key]').count(), { timeout: 20_000 })
        .toBe(TOTAL_MESSAGES);
      expect(paginationDirections).toEqual(new Set(['before', 'after']));

      // Native find only sees mounted DOM. The frozen viewer keeps all loaded
      // rows mounted, so a marker near the far edge must be discoverable.
      await page.keyboard.press('Control+f');
      await page.keyboard.type('history-marker-499');
      await expect(page.getByTestId('assistant-message-history-message-499')).toBeVisible();
      await page.keyboard.press('Escape');

      // Streaming follows the newest output while pinned at the bottom, but
      // must leave a reader's current anchor untouched after they scroll up.
      await scrollToEdge(page, 'bottom');
      expect((await scrollMetrics(page)).distanceFromBottom).toBeLessThanOrEqual(2);
      const firstChunk = `${'stream-marker-pinned\n'.repeat(180)}final-pinned-marker`;
      await streamAssistantMessage(page, historyThread.id, 'history-message-499', firstChunk);
      await expect.poll(() => page.locator('[data-virtual-row-key]').count()).toBe(TOTAL_MESSAGES);
      await expect(page.getByTestId('assistant-message-history-message-499')).toContainText(
        'final-pinned-marker',
      );
      await expect
        .poll(() => scrollMetrics(page).then((metrics) => metrics.distanceFromBottom))
        .toBeLessThanOrEqual(2);

      await scrollToProgress(page, 0.5);
      const beforeStream = await visibleAnchor(page);
      const beforeStreamMetrics = await scrollMetrics(page);
      expect(beforeStreamMetrics.distanceFromBottom).toBeGreaterThan(50);
      const secondChunk = `${firstChunk}\n${'stream-marker-reading\n'.repeat(180)}final-reading-marker`;
      await streamAssistantMessage(page, historyThread.id, 'history-message-499', secondChunk);
      await expect(page.getByTestId('assistant-message-history-message-499')).toContainText(
        'final-reading-marker',
      );
      const afterStream = await visibleAnchor(page);
      expect(afterStream.key).toBe(beforeStream.key);
      expect(Math.abs(afterStream.offset - beforeStream.offset)).toBeLessThan(8);
      expect((await scrollMetrics(page)).distanceFromBottom).toBeGreaterThan(50);

      const beforeSwitch = await visibleAnchor(page);

      await page.goto(`${baseURL}/projects/${project.id}/threads/${alternateThread.id}`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.getByTestId('frozen-message-list')).toBeVisible();
      await page.goto(`${baseURL}/projects/${project.id}/threads/${historyThread.id}`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.locator(`[data-virtual-row-key="${beforeSwitch.key}"]`)).toBeVisible();
      const afterSwitch = await visibleAnchor(page);

      expect(afterSwitch.key).toBe(beforeSwitch.key);
      expect(Math.abs(afterSwitch.offset - beforeSwitch.offset)).toBeLessThan(8);
      expect(errors).toEqual([]);
    } finally {
      await api.deleteThread(historyThread.id).catch(() => {});
      await api.deleteThread(alternateThread.id).catch(() => {});
      await api.deleteProject(project.id).catch(() => {});
    }
  });
});
