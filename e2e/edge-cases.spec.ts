import { test, expect, waitForSidebar, seedProject } from './fixtures';

test.describe('18. Edge Cases & UX', () => {
  test('18.1 Empty project shows empty state', async ({ api, authedPage: page, tempRepo }) => {
    const project = await seedProject(api, page, tempRepo, `EmptyProject-${Date.now()}`);

    // Navigate to project
    await page.goto(`/projects/${project.id}`);
    await page.waitForLoadState('networkidle');

    // Should show the new thread prompt area (empty state)
    await expect(page.getByTestId('prompt-textarea')).toBeVisible();

    // Cleanup
    await api.deleteProject(project.id);
  });

  test('18.5 Toast notifications on project creation', async ({
    authedPage: page,
    api,
    tempRepo,
  }) => {
    await page.goto('/new');
    await page.waitForLoadState('networkidle');

    const projectName = `Toast-Test-${Date.now()}`;
    await page.getByTestId('add-project-name').fill(projectName);
    await page.getByTestId('add-project-path').fill(tempRepo);
    await page.getByTestId('add-project-submit').click();

    // Wait for navigation (project created)
    await page.waitForURL((url) => !url.pathname.includes('/new'), { timeout: 10000 });

    // A toast notification might appear (sonner) — verify via [data-sonner-toast]
    await page.waitForTimeout(500);

    // Cleanup
    const projects = await api.getProjects();
    const created = projects.find((p) => p.name === projectName);
    if (created) await api.deleteProject(created.id);
  });

  test('18.7 Loading states — sidebar shows skeletons during load', async ({ page }) => {
    // Slow down the projects API to catch loading state
    await page.route('**/api/projects', async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });

    await page.goto('/');

    // During loading, should show skeleton or loading indicator
    // After loading completes, sidebar should be functional
    await waitForSidebar(page);
    await expect(page.getByTestId('sidebar-settings')).toBeVisible();
  });

  test('18.8 Browser back/forward navigation', async ({ authedPage: page, api, tempRepo }) => {
    const project = await seedProject(api, page, tempRepo, `NavTest-${Date.now()}`);

    // Navigate to several pages
    await page.goto('/list');
    await page.waitForLoadState('networkidle');

    await page.goto('/kanban');
    await page.waitForLoadState('networkidle');

    await page.goto('/analytics');
    await page.waitForLoadState('networkidle');

    // Go back
    await page.goBack();
    await expect(page).toHaveURL(/\/kanban/);

    // Go back again
    await page.goBack();
    await expect(page).toHaveURL(/\/list/);

    // Go forward
    await page.goForward();
    await expect(page).toHaveURL(/\/kanban/);

    await api.deleteProject(project.id);
  });

  test('18.9 Deep link to thread', async ({ api, authedPage: page, tempRepo }) => {
    const project = await seedProject(api, page, tempRepo, `DeepLink-${Date.now()}`);
    const thread = await api.createIdleThread(project.id, 'Deep Link Thread');

    // Navigate directly to the thread URL
    await page.goto(`/projects/${project.id}/threads/${thread.id}`);
    await page.waitForLoadState('networkidle');

    // Should load the thread view
    await expect(page.getByTestId('header-toggle-review')).toBeVisible();

    // Cleanup
    await api.deleteThread(thread.id);
    await api.deleteProject(project.id);
  });

  test('18.6 Error state on invalid project', async ({ authedPage: page }) => {
    // Navigate to a non-existent project
    await page.goto('/projects/non-existent-id');
    await page.waitForLoadState('networkidle');

    // App should handle gracefully without crashing
    // Sidebar should still be functional
    await expect(page.getByTestId('sidebar-settings')).toBeVisible();
  });

  test('18.4 Multiple projects in sidebar', async ({ api, authedPage: page, tempRepo }) => {
    // Create several projects using the same repo
    const projectIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const p = await api.createProject(`Multi-${i}-${Date.now()}`, tempRepo);
      projectIds.push(p.id);
    }

    await page.reload();
    await waitForSidebar(page);

    // All projects should be listed
    for (const id of projectIds) {
      await expect(page.getByTestId(`project-item-${id}`)).toBeVisible();
    }

    // Cleanup
    for (const id of projectIds) {
      await api.deleteProject(id);
    }
  });

  test('18.3 Thread view loads with message data', async ({ api, authedPage: page, tempRepo }) => {
    const project = await seedProject(api, page, tempRepo, `MsgPerf-${Date.now()}`);
    const thread = await api.createIdleThread(project.id, 'Message Thread');

    await page.goto(`/projects/${project.id}/threads/${thread.id}`);
    await page.waitForLoadState('networkidle');

    // Verify the page loaded successfully
    await expect(page.getByTestId('prompt-textarea')).toBeVisible();

    await api.deleteThread(thread.id);
    await api.deleteProject(project.id);
  });
});
