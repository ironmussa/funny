import { test, expect, seedProject } from './fixtures';

test.describe('10. All Threads View', () => {
  let projectId: string;
  let threadIds: string[] = [];

  test.beforeEach(async ({ api, authedPage: page, tempRepo }) => {
    const project = await seedProject(api, page, tempRepo, `AllThreads-${Date.now()}`);
    projectId = project.id;

    // Create a few threads
    for (let i = 1; i <= 3; i++) {
      const thread = await api.createIdleThread(projectId, `Thread ${i}`, { stage: 'backlog' });
      threadIds.push(thread.id);
    }
  });

  test.afterEach(async ({ api }) => {
    for (const id of threadIds) {
      await api.deleteThread(id).catch(() => {});
    }
    threadIds = [];
    await api.deleteProject(projectId).catch(() => {});
  });

  test('10.1 List view renders', async ({ authedPage: page }) => {
    await page.goto('/list');
    await page.waitForLoadState('networkidle');

    // List view tab should be active
    await expect(page.getByTestId('all-threads-list-view')).toBeVisible();
    await expect(page.getByTestId('all-threads-board-view')).toBeVisible();

    // Search should be visible
    await expect(page.getByTestId('all-threads-search')).toBeVisible();
  });

  test('10.2 Board view renders', async ({ authedPage: page }) => {
    await page.goto('/list');
    await page.waitForLoadState('networkidle');

    // Switch to board view
    await page.getByTestId('all-threads-board-view').click();
    await expect(page).toHaveURL(/\/kanban/);
  });

  test('10.3 Full-text search', async ({ authedPage: page }) => {
    await page.goto('/list');
    await page.waitForLoadState('networkidle');

    const search = page.getByTestId('all-threads-search');
    await search.fill('Thread 1');
    await page.waitForTimeout(500);

    // Clear button should appear
    await expect(page.getByTestId('all-threads-clear-search')).toBeVisible();

    // Clear search
    await page.getByTestId('all-threads-clear-search').click();
    await expect(search).toHaveValue('');
  });

  test('10.4 Project filter', async ({ authedPage: page }) => {
    await page.goto('/list');
    await page.waitForLoadState('networkidle');

    const projectFilter = page.getByTestId('all-threads-project-filter');
    await expect(projectFilter).toBeVisible();
  });

  test('10.5 Sort toggle', async ({ authedPage: page }) => {
    await page.goto('/list');
    await page.waitForLoadState('networkidle');

    const sortBtn = page.getByTestId('all-threads-sort');
    await expect(sortBtn).toBeVisible();
    await sortBtn.click();
    await page.waitForTimeout(300);
  });

  test('10.6 Sort direction toggle', async ({ authedPage: page }) => {
    await page.goto('/list');
    await page.waitForLoadState('networkidle');

    const dirBtn = page.getByTestId('all-threads-sort-direction');
    await expect(dirBtn).toBeVisible();
    await dirBtn.click();
    await page.waitForTimeout(300);
  });

  test('10.7 Show archived toggle', async ({ authedPage: page, api }) => {
    // Archive one thread first
    await api.archiveThread(threadIds[0]);

    await page.goto('/list');
    await page.waitForLoadState('networkidle');

    const archivedBtn = page.getByTestId('all-threads-show-archived');
    await expect(archivedBtn).toBeVisible();
    await archivedBtn.click();
    await page.waitForTimeout(500);
  });

  test('10.8 Clear filters', async ({ authedPage: page }) => {
    await page.goto('/list');
    await page.waitForLoadState('networkidle');

    // Apply a search filter first
    await page.getByTestId('all-threads-search').fill('something');
    await page.waitForTimeout(300);

    const clearBtn = page.getByTestId('all-threads-clear-filters');
    if (await clearBtn.isVisible()) {
      await clearBtn.click();
      await expect(page.getByTestId('all-threads-search')).toHaveValue('');
    }
  });

  test('10.10 Tab switch list/board', async ({ authedPage: page }) => {
    await page.goto('/list');
    await page.waitForLoadState('networkidle');

    // Switch to board
    await page.getByTestId('all-threads-board-view').click();
    await expect(page).toHaveURL(/\/kanban/);

    // Switch back to list
    await page.getByTestId('all-threads-list-view').click();
    await expect(page).toHaveURL(/\/list/);
  });
});
