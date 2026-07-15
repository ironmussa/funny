import type { Page } from '@playwright/test';

import { expect, seedProject, test } from './fixtures';
import { mockMessage, mockPaginatedThreadResponse, mockThreadWithMessages } from './mock-helpers';

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

/**
 * Drive the same thread-store mutation used after an `agent:message` socket
 * event has been batched. Dynamic import keeps the assertion in the browser
 * against the app's actual Zustand singleton without depending on a runner.
 */
async function streamAssistantMessage(
  page: Page,
  threadId: string,
  messageId: string,
  content: string,
) {
  await page.evaluate(
    async ({ nextThreadId, nextMessageId, nextContent }) => {
      const moduleUrl = '/src/stores/thread-store.ts';
      const { useThreadStore } = await import(/* @vite-ignore */ moduleUrl);
      useThreadStore.getState().handleWSMessage(nextThreadId, {
        messageId: nextMessageId,
        role: 'assistant',
        content: nextContent,
      });
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    },
    { nextThreadId: threadId, nextMessageId: messageId, nextContent: content },
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

      await scrollToProgress(page, 0.5);
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

  test('keeps following a stream only while the reader is pinned to the bottom', async ({
    api,
    authedPage: page,
    baseURL,
    tempRepo,
  }) => {
    test.setTimeout(120_000);
    const project = await seedProject(api, page, tempRepo, `StreamingPin-${Date.now()}`);
    const thread = await api.createIdleThread(project.id, 'Streaming pin');
    const streamingMessage = mockMessage({
      id: 'streaming-message',
      threadId: thread.id,
      role: 'assistant',
      content: 'stream-marker-initial',
    });
    const history = mockThreadWithMessages(thread.id, project.id, {
      title: 'Streaming pin',
      status: 'completed',
      messages: [...longThreadMessages(thread.id).slice(0, 160), streamingMessage],
    });

    await setFrozenViewer(page);
    await mockPaginatedThreadResponse(page, thread.id, history, history.messages, {
      initialWindowStart: history.messages.length - WINDOW_SIZE,
      initialWindowSize: WINDOW_SIZE,
    });

    try {
      await page.goto(`${baseURL}/projects/${project.id}/threads/${thread.id}`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.getByTestId('frozen-message-list')).toBeVisible();
      await expect.poll(() => page.locator('[data-virtual-row-key]').count()).toBe(WINDOW_SIZE);
      await expect(page.locator('[data-virtual-row-key="streaming-message"]')).toContainText(
        'stream-marker-initial',
      );
      await scrollToEdge(page, 'bottom');
      expect((await scrollMetrics(page)).distanceFromBottom).toBeLessThanOrEqual(2);

      const firstChunk = `${'stream-marker-pinned\n'.repeat(180)}final-pinned-marker`;
      await streamAssistantMessage(page, thread.id, streamingMessage.id, firstChunk);
      await expect.poll(() => page.locator('[data-virtual-row-key]').count()).toBe(WINDOW_SIZE);
      await expect(page.locator('[data-virtual-row-key="streaming-message"]')).toContainText(
        'final-pinned-marker',
      );
      await expect
        .poll(() => scrollMetrics(page).then((metrics) => metrics.distanceFromBottom))
        .toBeLessThanOrEqual(2);

      await scrollToProgress(page, 0.35);
      const beforeReading = await visibleAnchor(page);
      const beforeReadingMetrics = await scrollMetrics(page);
      expect(beforeReadingMetrics.distanceFromBottom).toBeGreaterThan(50);

      const secondChunk = `${firstChunk}\n${'stream-marker-reading\n'.repeat(180)}final-reading-marker`;
      await streamAssistantMessage(page, thread.id, streamingMessage.id, secondChunk);
      await expect(page.locator('[data-virtual-row-key="streaming-message"]')).toContainText(
        'final-reading-marker',
      );

      const afterReading = await visibleAnchor(page);
      const afterReadingMetrics = await scrollMetrics(page);
      expect(afterReading.key).toBe(beforeReading.key);
      expect(Math.abs(afterReading.offset - beforeReading.offset)).toBeLessThan(8);
      expect(afterReadingMetrics.distanceFromBottom).toBeGreaterThan(50);
    } finally {
      await api.deleteThread(thread.id).catch(() => {});
      await api.deleteProject(project.id).catch(() => {});
    }
  });
});
