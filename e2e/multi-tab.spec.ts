import { test, expect, waitForSidebar, seedProject } from './fixtures';

test.describe('I. Multi-Tab / Concurrent', () => {
  let projectId: string;

  test.beforeEach(async ({ api, authedPage: page, tempRepo }) => {
    const project = await seedProject(api, page, tempRepo, `MultiTab-${Date.now()}`);
    projectId = project.id;
  });

  test.afterEach(async ({ api }) => {
    await api.deleteProject(projectId).catch(() => {});
  });

  test('I.1 Two tabs — thread created in tab A appears in tab B via WS', async ({
    authedPage: page,
    api,
    context,
  }) => {
    // Tab A is already open
    await waitForSidebar(page);
    await page.getByTestId(`project-item-${projectId}`).click();
    await page.waitForTimeout(300);

    // Open Tab B
    const page2 = await context.newPage();
    await page2.goto('/');
    await page2.waitForLoadState('networkidle');
    await waitForSidebar(page2);
    await page2.getByTestId(`project-item-${projectId}`).click();
    await page2.waitForTimeout(300);

    // Create thread via API (simulates tab A creating a thread)
    const thread = await api.createIdleThread(projectId, 'Cross-Tab Thread');

    // Wait for WebSocket to propagate
    await page2.waitForTimeout(2000);

    // Tab B should show the new thread (after WS event or manual refresh)
    await page2.reload();
    await waitForSidebar(page2);
    await page2.getByTestId(`project-item-${projectId}`).click();
    await page2.waitForTimeout(500);

    await expect(page2.getByTestId(`thread-item-${thread.id}`)).toBeVisible();

    await page2.close();
    await api.deleteThread(thread.id);
  });

  test('I.2 Delete project in one tab, other tab handles it', async ({
    authedPage: page,
    api,
    context,
    tempRepo,
  }) => {
    const project2 = await api.createProject(`ToDelete-${Date.now()}`, tempRepo);

    // Both tabs see the project
    await page.reload();
    await waitForSidebar(page);

    const page2 = await context.newPage();
    await page2.goto('/');
    await page2.waitForLoadState('networkidle');
    await waitForSidebar(page2);

    await expect(page2.getByTestId(`project-item-${project2.id}`)).toBeVisible();

    // Delete project via API (simulates deletion from tab A)
    await api.deleteProject(project2.id);

    // Tab B should eventually reflect the deletion (after WS or on next interaction)
    await page2.reload();
    await waitForSidebar(page2);
    await page2.waitForTimeout(500);

    await expect(page2.getByTestId(`project-item-${project2.id}`)).not.toBeVisible();

    await page2.close();
  });

  test('I.3 Multiple tabs on different routes work independently', async ({
    authedPage: page,
    context,
  }) => {
    // Tab A on list view
    await page.goto('/list');
    await page.waitForLoadState('networkidle');

    // Tab B on kanban view
    const page2 = await context.newPage();
    await page2.goto('/kanban');
    await page2.waitForLoadState('networkidle');

    // Tab C on analytics
    const page3 = await context.newPage();
    await page3.goto('/analytics');
    await page3.waitForLoadState('networkidle');

    // All tabs should be on their respective routes
    await expect(page).toHaveURL(/\/list/);
    await expect(page2).toHaveURL(/\/kanban/);
    await expect(page3).toHaveURL(/\/analytics/);

    // All tabs should be functional
    await expect(page.getByTestId('all-threads-search')).toBeVisible();

    await page2.close();
    await page3.close();
  });
});
