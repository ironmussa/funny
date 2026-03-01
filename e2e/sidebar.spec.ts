import { test, expect, waitForSidebar, seedProject } from './fixtures';

test.describe('2. Sidebar', () => {
  test('2.1 Sidebar renders with navigation icons', async ({ authedPage: page }) => {
    await waitForSidebar(page);

    await expect(page.getByTestId('sidebar-search')).toBeVisible();
    await expect(page.getByTestId('sidebar-kanban')).toBeVisible();
    await expect(page.getByTestId('sidebar-grid')).toBeVisible();
    await expect(page.getByTestId('sidebar-analytics')).toBeVisible();
    await expect(page.getByTestId('sidebar-settings')).toBeVisible();
  });

  test('2.2 Sidebar collapse/expand', async ({ authedPage: page }) => {
    await waitForSidebar(page);

    // Collapse sidebar
    await page.getByTestId('sidebar-collapse').click();

    // After collapse, the main nav icons should be hidden
    await expect(page.getByTestId('sidebar-search')).not.toBeVisible();

    // Click the expand button (PanelLeft icon in collapsed strip)
    const _expandBtn = page.locator('[data-testid="sidebar-collapse"]');
    // In collapsed state, there should be an expand trigger
    await page.locator('aside').first().click();
    // Wait a bit for animation
    await page.waitForTimeout(300);
  });

  test('2.4 Navigate to /list via search icon', async ({ authedPage: page }) => {
    await waitForSidebar(page);
    await page.getByTestId('sidebar-search').click();
    await expect(page).toHaveURL(/\/list/);
  });

  test('2.5 Navigate to /kanban', async ({ authedPage: page }) => {
    await waitForSidebar(page);
    await page.getByTestId('sidebar-kanban').click();
    await expect(page).toHaveURL(/\/kanban/);
  });

  test('2.6 Navigate to /grid', async ({ authedPage: page }) => {
    await waitForSidebar(page);
    await page.getByTestId('sidebar-grid').click();
    await expect(page).toHaveURL(/\/grid/);
  });

  test('2.7 Navigate to /analytics', async ({ authedPage: page }) => {
    await waitForSidebar(page);
    await page.getByTestId('sidebar-analytics').click();
    await expect(page).toHaveURL(/\/analytics/);
  });

  test('2.8 Add project navigates to /new', async ({ authedPage: page }) => {
    await waitForSidebar(page);
    await page.getByTestId('sidebar-add-project').click();
    await expect(page).toHaveURL(/\/new/);
  });

  test('2.19 Settings gear icon opens dialog', async ({ authedPage: page }) => {
    await waitForSidebar(page);
    await page.getByTestId('sidebar-settings').click();

    // Settings dialog should open
    await expect(page.getByTestId('settings-dialog-save')).toBeVisible();
    await expect(page.getByTestId('settings-dialog-cancel')).toBeVisible();
  });

  test('2.20 No projects CTA visible when no projects', async ({ authedPage: page, api }) => {
    await waitForSidebar(page);

    // Delete all existing projects first
    const projects = await api.getProjects();
    for (const p of projects) {
      await api.deleteProject(p.id);
    }
    await page.reload();
    await waitForSidebar(page);

    // The "no projects" CTA should be visible
    await expect(page.getByTestId('sidebar-no-projects-cta')).toBeVisible();
  });

  test.describe('with seeded project', () => {
    let projectId: string;
    let repoPath: string;

    test.beforeEach(async ({ api, authedPage: page, tempRepo }) => {
      repoPath = tempRepo;
      const project = await seedProject(api, page, repoPath, `Sidebar-Test-${Date.now()}`);
      projectId = project.id;
    });

    test.afterEach(async ({ api }) => {
      await api.deleteProject(projectId).catch(() => {});
    });

    test('2.9 Project accordion expand/collapse', async ({ authedPage: page }) => {
      const projectItem = page.getByTestId(`project-item-${projectId}`);
      await expect(projectItem).toBeVisible();

      // Click to expand
      await projectItem.click();
      // The "new thread" button should become visible inside the expanded section
      await expect(page.getByTestId(`project-new-thread-${projectId}`)).toBeVisible();
    });

    test('2.10 Project context menu - rename', async ({ authedPage: page }) => {
      // Open the project more-actions menu
      await page.getByTestId(`project-more-actions-${projectId}`).click();
      await page.getByTestId('project-menu-rename').click();

      // Rename dialog should appear with input
      const input = page.getByTestId('rename-project-input');
      await expect(input).toBeVisible();

      // Clear and type new name
      await input.clear();
      await input.fill('Renamed Project');
      await page.getByTestId('rename-project-confirm').click();

      // Verify the project name changed in the sidebar
      await expect(page.getByText('Renamed Project')).toBeVisible();
    });

    test('2.10b Project rename cancel', async ({ authedPage: page }) => {
      await page.getByTestId(`project-more-actions-${projectId}`).click();
      await page.getByTestId('project-menu-rename').click();

      const input = page.getByTestId('rename-project-input');
      await expect(input).toBeVisible();

      // Cancel should close without renaming
      await page.getByTestId('rename-project-cancel').click();
      await expect(input).not.toBeVisible();
    });

    test('2.11 Project context menu - delete', async ({ authedPage: page }) => {
      await page.getByTestId(`project-more-actions-${projectId}`).click();
      await page.getByTestId('project-menu-delete').click();

      // Confirm dialog should appear
      await expect(page.getByTestId('delete-project-confirm')).toBeVisible();
      await expect(page.getByTestId('delete-project-cancel')).toBeVisible();

      // Confirm deletion
      await page.getByTestId('delete-project-confirm').click();

      // Project should no longer be in sidebar
      await expect(page.getByTestId(`project-item-${projectId}`)).not.toBeVisible();
    });

    test('2.11b Project delete cancel', async ({ authedPage: page }) => {
      await page.getByTestId(`project-more-actions-${projectId}`).click();
      await page.getByTestId('project-menu-delete').click();

      await page.getByTestId('delete-project-cancel').click();

      // Project should still be visible
      await expect(page.getByTestId(`project-item-${projectId}`)).toBeVisible();
    });
  });

  test.describe('with seeded project and thread', () => {
    let projectId: string;
    let threadId: string;

    test.beforeEach(async ({ api, authedPage: page, tempRepo }) => {
      const project = await seedProject(api, page, tempRepo, `Thread-Sidebar-${Date.now()}`);
      projectId = project.id;
      const thread = await api.createIdleThread(projectId, 'Test Thread');
      threadId = thread.id;
      await page.reload();
      await waitForSidebar(page);
    });

    test.afterEach(async ({ api }) => {
      await api.deleteThread(threadId).catch(() => {});
      await api.deleteProject(projectId).catch(() => {});
    });

    test('2.12 Thread click navigates', async ({ authedPage: page }) => {
      // Expand project first
      await page.getByTestId(`project-item-${projectId}`).click();
      await page.waitForTimeout(300);

      // Click thread
      await page.getByTestId(`thread-item-${threadId}`).click();
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/threads/${threadId}`));
    });

    test('2.13 Thread context menu - archive', async ({ authedPage: page }) => {
      await page.getByTestId(`project-item-${projectId}`).click();
      await page.waitForTimeout(300);

      // Open thread context menu
      await page.getByTestId(`thread-item-more-${threadId}`).click();

      // Click archive option
      await page.getByText('Archive').click();

      // Confirm dialog
      await expect(page.getByTestId('archive-thread-confirm')).toBeVisible();
      await page.getByTestId('archive-thread-confirm').click();

      // Thread should disappear from sidebar
      await expect(page.getByTestId(`thread-item-${threadId}`)).not.toBeVisible();
    });

    test('2.13b Thread archive cancel', async ({ authedPage: page }) => {
      await page.getByTestId(`project-item-${projectId}`).click();
      await page.waitForTimeout(300);

      await page.getByTestId(`thread-item-more-${threadId}`).click();
      await page.getByText('Archive').click();

      await page.getByTestId('archive-thread-cancel').click();

      // Thread should still be visible
      await expect(page.getByTestId(`thread-item-${threadId}`)).toBeVisible();
    });

    test('2.15 Thread context menu - delete', async ({ authedPage: page }) => {
      await page.getByTestId(`project-item-${projectId}`).click();
      await page.waitForTimeout(300);

      await page.getByTestId(`thread-item-more-${threadId}`).click();
      await page.getByText('Delete').click();

      await expect(page.getByTestId('delete-thread-confirm')).toBeVisible();
      await page.getByTestId('delete-thread-confirm').click();

      await expect(page.getByTestId(`thread-item-${threadId}`)).not.toBeVisible();
    });

    test('2.15b Thread delete cancel', async ({ authedPage: page }) => {
      await page.getByTestId(`project-item-${projectId}`).click();
      await page.waitForTimeout(300);

      await page.getByTestId(`thread-item-more-${threadId}`).click();
      await page.getByText('Delete').click();

      await page.getByTestId('delete-thread-cancel').click();

      await expect(page.getByTestId(`thread-item-${threadId}`)).toBeVisible();
    });
  });
});
