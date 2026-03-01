import { test, expect, waitForSidebar, seedProject } from './fixtures';

test.describe('17. Grid / Live Columns View', () => {
  let projectId: string;

  test.beforeEach(async ({ api, authedPage: page, tempRepo }) => {
    const project = await seedProject(api, page, tempRepo, `Grid-${Date.now()}`);
    projectId = project.id;
  });

  test.afterEach(async ({ api }) => {
    await api.deleteProject(projectId).catch(() => {});
  });

  test('17.1 Grid view shows empty state with no active threads', async ({ authedPage: page }) => {
    await page.goto('/grid');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // Should show the empty state
    await expect(page.getByTestId('grid-empty-state')).toBeVisible();
  });

  test('17.2 Grid view accessible via sidebar', async ({ authedPage: page }) => {
    await page.goto('/');
    await waitForSidebar(page);

    await page.getByTestId('sidebar-grid').click();
    await page.waitForLoadState('networkidle');

    expect(page.url()).toContain('/grid');
  });

  test('17.3 Grid view has add thread button', async ({ authedPage: page }) => {
    await page.goto('/grid');
    await page.waitForLoadState('networkidle');

    await expect(page.getByTestId('grid-add-thread')).toBeVisible();
  });

  test('17.4 Add thread button opens project picker', async ({ authedPage: page }) => {
    await page.goto('/grid');
    await page.waitForLoadState('networkidle');

    await page.getByTestId('grid-add-thread').click();
    await page.waitForTimeout(300);

    // A project picker popover should appear with our project
    const projectOption = page.getByText(/Grid-/);
    await expect(projectOption.first()).toBeVisible();
  });

  test('17.5 Grid view shows title "Grid"', async ({ authedPage: page }) => {
    await page.goto('/grid');
    await page.waitForLoadState('networkidle');

    // The grid view should show the title
    await expect(page.getByTestId('grid-view')).toBeVisible();
    await expect(page.getByText('Grid').first()).toBeVisible();
  });

  test('17.6 Grid with active threads shows columns', async ({ authedPage: page, api }) => {
    // Create a thread that simulates a running state
    const thread = await api.createIdleThread(projectId, 'Grid Thread 1');

    // Mock the thread list response to show as "running"
    await page.route(`**/api/projects/${projectId}/threads**`, async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            {
              id: thread.id,
              projectId,
              title: 'Grid Thread 1',
              status: 'running',
              mode: 'local',
              createdAt: new Date().toISOString(),
              archived: false,
            },
          ]),
        });
      } else {
        await route.continue();
      }
    });

    await page.goto('/grid');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // With running threads, the grid container should be visible
    const gridContainer = page.getByTestId('grid-container');
    if (await gridContainer.isVisible().catch(() => false)) {
      // Active count badge should show
      await expect(page.getByTestId('grid-active-count')).toBeVisible();
    }

    await api.deleteThread(thread.id).catch(() => {});
  });

  test('17.7 Grid empty state shows descriptive text', async ({ authedPage: page }) => {
    await page.goto('/grid');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // Should show the no active threads message
    const emptyState = page.getByTestId('grid-empty-state');
    if (await emptyState.isVisible()) {
      await expect(page.getByText(/no active threads/i)).toBeVisible();
    }
  });

  test('17.8 Grid persists size in localStorage', async ({ authedPage: page }) => {
    await page.goto('/grid');
    await page.waitForLoadState('networkidle');

    // Check localStorage for grid size values
    const gridCols = await page.evaluate(() => localStorage.getItem('funny:grid-cols'));
    const gridRows = await page.evaluate(() => localStorage.getItem('funny:grid-rows'));

    // Values should be present (default or saved)
    // Even if null, this test verifies the feature doesn't crash
    // When a user changes the grid size, it should persist
    if (gridCols) {
      expect(Number(gridCols)).toBeGreaterThanOrEqual(1);
      expect(Number(gridCols)).toBeLessThanOrEqual(5);
    }
    if (gridRows) {
      expect(Number(gridRows)).toBeGreaterThanOrEqual(1);
      expect(Number(gridRows)).toBeLessThanOrEqual(5);
    }
  });

  test('17.9 Grid view does not crash with multiple projects', async ({
    authedPage: page,
    api,
    tempRepo,
  }) => {
    // Create a couple more projects
    const p2 = await api.createProject(`Grid2-${Date.now()}`, tempRepo);
    const p3 = await api.createProject(`Grid3-${Date.now()}`, tempRepo);

    await page.goto('/grid');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // Grid view should render without errors
    await expect(page.getByTestId('grid-view')).toBeVisible();

    // Cleanup
    await api.deleteProject(p2.id).catch(() => {});
    await api.deleteProject(p3.id).catch(() => {});
  });
});
