import { test, expect, seedProject, waitForSidebar, type Thread } from './fixtures';

/**
 * End-to-end coverage for the in-app browser annotator panel.
 * See `openspec/changes/in-app-annotator-panel/` for the spec.
 *
 * These specs intentionally avoid relying on the iframe actually rendering
 * the URL — they target the panel's interaction model, not iframe internals.
 */

const BLANK_URL = 'about:blank';

async function openPanel(page: import('@playwright/test').Page) {
  // The sidebar icon row is only visible on hover; force the trigger anyway.
  await page.getByTestId('sidebar-browser-panel').click({ force: true });
  await expect(page.getByTestId('browser-panel')).toBeVisible();
}

async function loadUrl(page: import('@playwright/test').Page, url: string) {
  await page.getByTestId('browser-panel-url-input').fill(url);
  await page.getByTestId('browser-panel-url-go').click();
}

function mockCreateThread(
  page: import('@playwright/test').Page,
  thread: Partial<Thread> & { id: string },
) {
  return page.route('**/api/threads', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: thread.id,
        projectId: thread.projectId ?? 'p1',
        title: thread.title ?? 'Annotated thread',
        mode: 'local',
        status: 'idle',
        stage: 'created',
        provider: 'claude',
        model: 'sonnet',
        branch: 'main',
        createdAt: new Date().toISOString(),
      }),
    });
  });
}

test.describe('Browser annotator panel', () => {
  let projectId: string;

  test.beforeEach(async ({ api, authedPage: page, tempRepo }) => {
    const project = await seedProject(api, page, tempRepo, `BrowserPanel-${Date.now()}`);
    projectId = project.id;
    await waitForSidebar(page);
  });

  test.afterEach(async ({ api }) => {
    await api.deleteProject(projectId).catch(() => {});
  });

  test('13.1 pin → send creates a thread and navigates', async ({ authedPage: page }) => {
    await openPanel(page);

    // Paste a URL.
    await loadUrl(page, BLANK_URL);

    // Switch to Pin and click on the overlay surface.
    await page.getByTestId('browser-panel-tool-pin').click();
    await page.getByTestId('pin-tool-surface').click({ position: { x: 120, y: 80 } });

    // Pin marker appears with index 1; popover textarea is focused.
    await expect(page.getByTestId('browser-panel-pin-1')).toBeVisible();
    await page.keyboard.type('broken button');
    await page.getByTestId('browser-panel-pin-save').click();

    // Send button is enabled now that we have a URL and an annotation.
    const sendBtn = page.getByTestId('browser-panel-send');
    await expect(sendBtn).toBeEnabled();

    // Mock the createThread response so we don't actually start an agent.
    await mockCreateThread(page, { id: 'mock-thread-1', projectId });

    await sendBtn.click();
    await expect(page.getByTestId('browser-panel-send-dialog')).toBeVisible();
    await page.getByTestId('browser-panel-send-confirm').click();

    // Navigated to the new thread.
    await expect(page).toHaveURL(/\/threads\/mock-thread-1/);
  });

  test('13.2 draw tool: color change + clear, send includes an image attachment', async ({
    authedPage: page,
  }) => {
    await openPanel(page);
    await loadUrl(page, BLANK_URL);

    await page.getByTestId('browser-panel-tool-draw').click();

    const canvas = page.getByTestId('browser-panel-draw-canvas');
    await canvas.waitFor({ state: 'visible' });
    const box = await canvas.boundingBox();
    if (!box) throw new Error('canvas has no bounding box');

    // Draw a small stroke in the default (red) color.
    await page.mouse.move(box.x + 30, box.y + 30);
    await page.mouse.down();
    await page.mouse.move(box.x + 80, box.y + 80, { steps: 5 });
    await page.mouse.up();

    // One draw annotation should be present.
    await expect(page.getByTestId('browser-panel-annotation-1')).toBeVisible();

    // Switch color, draw another stroke.
    await page.getByTestId('browser-panel-draw-swatch-3b82f6').click();
    await page.mouse.move(box.x + 100, box.y + 50);
    await page.mouse.down();
    await page.mouse.move(box.x + 200, box.y + 150, { steps: 5 });
    await page.mouse.up();

    // Add a note for the draw annotation.
    await page.getByTestId('browser-panel-draw-note').fill('this whole area looks wrong');

    // Clear and confirm the draw annotation is removed from the list.
    await page.getByTestId('browser-panel-draw-clear').click();
    await expect(page.getByTestId('browser-panel-annotation-list-empty')).toBeVisible();

    // Draw again so we have something to send.
    await page.mouse.move(box.x + 50, box.y + 50);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 90, { steps: 5 });
    await page.mouse.up();

    // Capture the POST payload so we can assert images is non-empty.
    let payload: { images?: unknown[] } | null = null;
    await page.route('**/api/threads', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      payload = JSON.parse(route.request().postData() ?? '{}');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'mock-thread-2',
          projectId,
          title: 'Annotated: about:blank',
          mode: 'local',
          status: 'idle',
          stage: 'created',
          provider: 'claude',
          model: 'sonnet',
          branch: 'main',
          createdAt: new Date().toISOString(),
        }),
      });
    });

    await page.getByTestId('browser-panel-send').click();
    await page.getByTestId('browser-panel-send-confirm').click();

    await expect(page).toHaveURL(/\/threads\/mock-thread-2/);
    expect(payload).not.toBeNull();
    expect(Array.isArray(payload?.images)).toBe(true);
    expect((payload?.images ?? []).length).toBe(1);
  });

  test('13.3 region drag in reverse direction normalizes coords', async ({ authedPage: page }) => {
    await openPanel(page);
    await loadUrl(page, BLANK_URL);

    await page.getByTestId('browser-panel-tool-region').click();
    const surface = page.getByTestId('region-tool-surface');
    const box = await surface.boundingBox();
    if (!box) throw new Error('region surface has no bounding box');

    // Drag from (200, 200) to (100, 100) — reverse direction.
    const startX = box.x + 200;
    const startY = box.y + 200;
    const endX = box.x + 100;
    const endY = box.y + 100;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(endX, endY, { steps: 6 });
    await page.mouse.up();

    // Annotation 1 should exist; its summary should show positive w×h
    // (test against the overlay → coords are (100, 100, 100×100) within the
    // overlay's local coordinate system).
    const item = page.getByTestId('browser-panel-annotation-1');
    await expect(item).toBeVisible();
    await expect(item).toContainText('100×100');
  });
});
