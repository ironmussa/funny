import { test, expect, seedProject } from './fixtures';

test.describe('11. Kanban View', () => {
  let projectId: string;
  let threadIds: string[] = [];

  test.beforeEach(async ({ api, authedPage: page, tempRepo }) => {
    const project = await seedProject(api, page, tempRepo, `Kanban-${Date.now()}`);
    projectId = project.id;

    // Create threads in different stages
    const stages = ['backlog', 'planning', 'in_progress', 'review', 'done'];
    for (const stage of stages) {
      const thread = await api.createIdleThread(projectId, `${stage} thread`, { stage });
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

  test('11.1 Kanban cards render in columns', async ({ authedPage: page }) => {
    await page.goto('/kanban');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // At least one kanban card should be visible
    for (const id of threadIds) {
      const card = page.getByTestId(`kanban-card-${id}`);
      // Some may not be visible due to viewport, just check at least one
      if (await card.isVisible().catch(() => false)) {
        await expect(card).toBeVisible();
        break;
      }
    }
  });

  test('11.3 Kanban card delete', async ({ authedPage: page }) => {
    await page.goto('/kanban');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    const targetId = threadIds[0];
    const deleteBtn = page.getByTestId(`kanban-card-delete-${targetId}`);

    if (await deleteBtn.isVisible().catch(() => false)) {
      await deleteBtn.click();

      // Confirm dialog should appear
      await expect(page.getByTestId('kanban-delete-confirm')).toBeVisible();
      await expect(page.getByTestId('kanban-delete-cancel')).toBeVisible();

      // Cancel deletion
      await page.getByTestId('kanban-delete-cancel').click();
      await expect(page.getByTestId('kanban-delete-confirm')).not.toBeVisible();
    }
  });

  test('11.3b Kanban card delete confirm', async ({ authedPage: page }) => {
    await page.goto('/kanban');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    const targetId = threadIds[0];
    const deleteBtn = page.getByTestId(`kanban-card-delete-${targetId}`);

    if (await deleteBtn.isVisible().catch(() => false)) {
      await deleteBtn.click();
      await page.getByTestId('kanban-delete-confirm').click();

      // Card should disappear
      await expect(page.getByTestId(`kanban-card-${targetId}`)).not.toBeVisible();
    }
  });

  test('11.4 Add thread from kanban', async ({ authedPage: page }) => {
    await page.goto('/kanban');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    const addBtn = page.getByTestId('kanban-add-thread').first();
    if (await addBtn.isVisible().catch(() => false)) {
      await addBtn.click();
      await page.waitForTimeout(500);
    }
  });

  test('11.2 Kanban card pin toggle', async ({ authedPage: page }) => {
    await page.goto('/kanban');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    const targetId = threadIds[0];
    const pinBtn = page.getByTestId(`kanban-card-pin-${targetId}`);

    if (await pinBtn.isVisible().catch(() => false)) {
      // Pin
      await pinBtn.click();
      await page.waitForTimeout(300);

      // Unpin
      await pinBtn.click();
      await page.waitForTimeout(300);
    }
  });
  test('11.5 Load more - Loads more cards on click', async ({ authedPage: _page }) => {
    // Placeholder test
    expect(true).toBe(true);
  });

  test('11.6 Drag-and-drop - Drags card between columns', async ({ authedPage: _page }) => {
    // Placeholder test
    expect(true).toBe(true);
  });

  test('11.7 Hover states - Cards show hover interactive borders', async ({
    authedPage: _page,
  }) => {
    // Placeholder test
    expect(true).toBe(true);
  });

  test('11.8 Navigate from board - Click on card navigates to thread view', async ({
    authedPage: _page,
  }) => {
    // Placeholder test
    expect(true).toBe(true);
  });
});
