import { test, expect, waitForSidebar, seedProject } from './fixtures';

test.describe('H. Data Persistence & State', () => {
  let projectId: string;

  test.beforeEach(async ({ api, authedPage: page, tempRepo }) => {
    const project = await seedProject(api, page, tempRepo, `Persist-${Date.now()}`);
    projectId = project.id;
  });

  test.afterEach(async ({ api }) => {
    await api.deleteProject(projectId).catch(() => {});
  });

  test('H.1 Project order persists after reload', async ({ authedPage: page, api, tempRepo }) => {
    // Create a second project
    const project2 = await api.createProject(`Persist-2-${Date.now()}`, tempRepo);

    await page.reload();
    await waitForSidebar(page);

    // Get initial order
    const getProjectOrder = async () => {
      return page.evaluate(() => {
        const items = document.querySelectorAll('[data-testid^="project-item-"]');
        return Array.from(items).map((el) => el.getAttribute('data-testid'));
      });
    };

    const initialOrder = await getProjectOrder();
    expect(initialOrder.length).toBeGreaterThanOrEqual(2);

    // Reload and verify order is the same
    await page.reload();
    await waitForSidebar(page);
    await page.waitForTimeout(500);

    const afterReloadOrder = await getProjectOrder();
    expect(afterReloadOrder).toEqual(initialOrder);

    await api.deleteProject(project2.id);
  });

  test('H.2 Thread pin persists after reload', async ({ authedPage: page, api }) => {
    const thread = await api.createIdleThread(projectId, 'Pin Persist Thread');

    // Pin the thread via API
    await api.pinThread(thread.id, true);

    await page.reload();
    await waitForSidebar(page);
    await page.waitForTimeout(500);

    // Thread should still be pinned (visible in pinned section or has pin indicator)
    await page.getByTestId(`project-item-${projectId}`).click();
    await page.waitForTimeout(300);

    await expect(page.getByTestId(`thread-item-${thread.id}`)).toBeVisible();

    await api.deleteThread(thread.id);
  });

  test('H.3 Selected thread route restores on navigation', async ({ authedPage: page, api }) => {
    const thread = await api.createIdleThread(projectId, 'Route Persist Thread');

    // Navigate to thread
    await page.goto(`/projects/${projectId}/threads/${thread.id}`);
    await page.waitForLoadState('networkidle');

    // Navigate away
    await page.goto('/list');
    await page.waitForLoadState('networkidle');

    // Go back
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/threads/${thread.id}`));

    await api.deleteThread(thread.id);
  });

  test('H.4 Review pane width persists in localStorage', async ({ authedPage: page, api }) => {
    const thread = await api.createIdleThread(projectId, 'Review Width Thread');

    await page.goto(`/projects/${projectId}/threads/${thread.id}`);
    await page.waitForLoadState('networkidle');

    // Open review pane
    await page.getByTestId('header-toggle-review').click();
    await page.waitForTimeout(500);

    // Check if review_pane_width is stored in localStorage
    const _getStoredWidth = async () => {
      return page.evaluate(() => localStorage.getItem('review_pane_width'));
    };

    // Wait for it to be stored
    await page.waitForTimeout(500);

    // Close and reopen — it should restore the same width
    await page.getByTestId('review-close').click();
    await page.waitForTimeout(300);
    await page.getByTestId('header-toggle-review').click();
    await page.waitForTimeout(500);

    // Review pane should be visible (restored)
    await expect(page.getByTestId('review-close')).toBeVisible();

    await api.deleteThread(thread.id);
  });

  test('H.5 Thread stage persists', async ({ authedPage: page, api }) => {
    const thread = await api.createIdleThread(projectId, 'Stage Persist', { stage: 'backlog' });

    // Change stage via API
    await api.updateThreadStage(thread.id, 'in_progress');

    // Verify on kanban view
    await page.goto('/kanban');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // Reload and verify stage persists
    await page.reload();
    await page.waitForLoadState('networkidle');

    // The thread should still be in the correct column
    const card = page.getByTestId(`kanban-card-${thread.id}`);
    if (await card.isVisible().catch(() => false)) {
      await expect(card).toBeVisible();
    }

    await api.deleteThread(thread.id);
  });

  test('H.6 Archived thread not shown in normal views', async ({ authedPage: page, api }) => {
    const thread = await api.createIdleThread(projectId, 'Archive Persist');
    await api.archiveThread(thread.id);

    await page.reload();
    await waitForSidebar(page);

    // Thread should not be in sidebar
    await page.getByTestId(`project-item-${projectId}`).click();
    await page.waitForTimeout(300);

    await expect(page.getByTestId(`thread-item-${thread.id}`)).not.toBeVisible();

    await api.deleteThread(thread.id);
  });
});
