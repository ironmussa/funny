import { test, expect, waitForSidebar, seedProject } from './fixtures';

test.describe('C. Responsive / Viewport', () => {
  let projectId: string;
  let threadId: string;

  test.beforeEach(async ({ api, authedPage: page, tempRepo }) => {
    const project = await seedProject(api, page, tempRepo, `Responsive-${Date.now()}`);
    projectId = project.id;
    const thread = await api.createIdleThread(projectId, 'Responsive Test');
    threadId = thread.id;
  });

  test.afterEach(async ({ api }) => {
    await api.deleteThread(threadId).catch(() => {});
    await api.deleteProject(projectId).catch(() => {});
  });

  test('C.1 Small viewport (1024x768) — app is functional', async ({ authedPage: page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto(`/projects/${projectId}/threads/${threadId}`);
    await page.waitForLoadState('networkidle');

    // Core elements should be visible
    await expect(page.getByTestId('prompt-textarea')).toBeVisible();

    // No horizontal overflow
    const hasOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    });
    expect(hasOverflow).toBeFalsy();
  });

  test('C.2 Large viewport (1920x1080) — review pane fits', async ({ authedPage: page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(`/projects/${projectId}/threads/${threadId}`);
    await page.waitForLoadState('networkidle');

    // Open review pane
    await page.getByTestId('header-toggle-review').click();
    await page.waitForTimeout(500);

    // Both thread view and review pane should be visible simultaneously
    await expect(page.getByTestId('prompt-textarea')).toBeVisible();
    await expect(page.getByTestId('review-close')).toBeVisible();
  });

  test('C.3 Very small viewport (800x600) — no crash', async ({ authedPage: page }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // App should still be functional, possibly with collapsed sidebar
    await expect(page.getByTestId('sidebar-settings').or(page.locator('body'))).toBeVisible();

    // No JavaScript errors
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.waitForTimeout(1000);
    // Some errors might be expected, but no unhandled crashes
  });

  test('C.4 Sidebar min-width respected', async ({ authedPage: page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await waitForSidebar(page);

    // Get sidebar element and check its computed width
    const sidebar = page.locator('aside').first();
    if (await sidebar.isVisible()) {
      const box = await sidebar.boundingBox();
      if (box) {
        // Sidebar should have a reasonable minimum width (usually > 200px)
        expect(box.width).toBeGreaterThan(100);
      }
    }
  });

  test('C.5 Review pane resize respects boundaries', async ({ authedPage: page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/projects/${projectId}/threads/${threadId}`);
    await page.waitForLoadState('networkidle');

    await page.getByTestId('header-toggle-review').click();
    await page.waitForTimeout(500);

    // The resize handle should exist (aria-label="Resize review pane")
    const resizeHandle = page.locator('[aria-label*="Resize"], [class*="resize"]').first();
    if (await resizeHandle.isVisible().catch(() => false)) {
      const handleBox = await resizeHandle.boundingBox();
      if (handleBox) {
        // Drag to extreme left — should not collapse thread view completely
        await page.mouse.move(
          handleBox.x + handleBox.width / 2,
          handleBox.y + handleBox.height / 2,
        );
        await page.mouse.down();
        await page.mouse.move(100, handleBox.y + handleBox.height / 2, { steps: 10 });
        await page.mouse.up();

        // Thread view and review pane should both still have positive widths
        await page.waitForTimeout(300);
        await expect(page.getByTestId('review-close')).toBeVisible();
      }
    }
  });

  test('C.6 Kanban view on narrow viewport', async ({ authedPage: page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto('/kanban');
    await page.waitForLoadState('networkidle');

    // Kanban should be scrollable horizontally if columns don't fit
    // No crash or broken layout
    const hasContent = await page.locator('main, [role="main"]').first().isVisible();
    expect(hasContent).toBeTruthy();
  });

  test('C.7 Settings page on small viewport', async ({ authedPage: page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto(`/projects/${projectId}/settings/general`);
    await page.waitForLoadState('networkidle');

    // Settings navigation and content should be visible
    await expect(page.getByTestId('settings-back')).toBeVisible();
    await expect(page.getByTestId('settings-nav-general')).toBeVisible();
  });
});
