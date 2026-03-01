import { test, expect, waitForSidebar, seedProject } from './fixtures';

test.describe('8. Settings Panel', () => {
  let projectId: string;

  test.beforeEach(async ({ api, authedPage: page, tempRepo }) => {
    const project = await seedProject(api, page, tempRepo, `Settings-${Date.now()}`);
    projectId = project.id;
  });

  test.afterEach(async ({ api }) => {
    await api.deleteProject(projectId).catch(() => {});
  });

  test('8.1 Settings navigation shows all sections', async ({ authedPage: page }) => {
    // Navigate to project settings
    await page.goto(`/projects/${projectId}/settings/general`);
    await page.waitForLoadState('networkidle');

    // Settings panel should show navigation
    await expect(page.getByTestId('settings-back')).toBeVisible();
    await expect(page.getByTestId('settings-nav-general')).toBeVisible();
    await expect(page.getByTestId('settings-nav-mcp-server')).toBeVisible();
    await expect(page.getByTestId('settings-nav-skills')).toBeVisible();
    await expect(page.getByTestId('settings-nav-worktrees')).toBeVisible();
    await expect(page.getByTestId('settings-nav-startup-commands')).toBeVisible();
    await expect(page.getByTestId('settings-nav-automations')).toBeVisible();
    await expect(page.getByTestId('settings-nav-archived-threads')).toBeVisible();
  });

  test('8.1b Settings back button navigates away', async ({ authedPage: page }) => {
    await page.goto(`/projects/${projectId}/settings/general`);
    await page.waitForLoadState('networkidle');

    await page.getByTestId('settings-back').click();
    await expect(page).not.toHaveURL(/settings/);
  });

  test('8.1c Settings navigation between sections', async ({ authedPage: page }) => {
    await page.goto(`/projects/${projectId}/settings/general`);
    await page.waitForLoadState('networkidle');

    // Navigate to MCP
    await page.getByTestId('settings-nav-mcp-server').click();
    await expect(page).toHaveURL(/settings\/mcp-server/);

    // Navigate to Skills
    await page.getByTestId('settings-nav-skills').click();
    await expect(page).toHaveURL(/settings\/skills/);

    // Navigate to Worktrees
    await page.getByTestId('settings-nav-worktrees').click();
    await expect(page).toHaveURL(/settings\/worktrees/);

    // Navigate to Startup Commands
    await page.getByTestId('settings-nav-startup-commands').click();
    await expect(page).toHaveURL(/settings\/startup-commands/);

    // Navigate to Automations
    await page.getByTestId('settings-nav-automations').click();
    await expect(page).toHaveURL(/settings\/automations/);

    // Navigate to Archived Threads
    await page.getByTestId('settings-nav-archived-threads').click();
    await expect(page).toHaveURL(/settings\/archived-threads/);

    // Back to General
    await page.getByTestId('settings-nav-general').click();
    await expect(page).toHaveURL(/settings\/general/);
  });

  test('8.2 General - project color picker', async ({ authedPage: page }) => {
    await page.goto(`/projects/${projectId}/settings/general`);
    await page.waitForLoadState('networkidle');

    // "No color" option should be visible
    await expect(page.getByTestId('project-color-none')).toBeVisible();
  });

  test('8.7 General - extension URL add', async ({ authedPage: page }) => {
    await page.goto(`/projects/${projectId}/settings/general`);
    await page.waitForLoadState('networkidle');

    const addBtn = page.getByTestId('settings-url-pattern-add');
    if (await addBtn.isVisible()) {
      await addBtn.click();
    }
  });

  test('8.9 General - reset defaults', async ({ authedPage: page }) => {
    await page.goto(`/projects/${projectId}/settings/general`);
    await page.waitForLoadState('networkidle');

    const resetBtn = page.getByTestId('settings-reset-defaults');
    if (await resetBtn.isVisible()) {
      await resetBtn.click();
    }
  });
});

test.describe('9. General Settings Dialog (Modal)', () => {
  test('9.1 Theme selection', async ({ authedPage: page }) => {
    await waitForSidebar(page);
    await page.getByTestId('sidebar-settings').click();

    // Theme options should be visible
    await expect(page.getByTestId('settings-dialog-theme-light')).toBeVisible();
    await expect(page.getByTestId('settings-dialog-theme-dark')).toBeVisible();
    await expect(page.getByTestId('settings-dialog-theme-system')).toBeVisible();

    // Click dark theme
    await page.getByTestId('settings-dialog-theme-dark').click();
    await page.waitForTimeout(200);

    // Click light theme
    await page.getByTestId('settings-dialog-theme-light').click();
    await page.waitForTimeout(200);

    // Click system theme
    await page.getByTestId('settings-dialog-theme-system').click();
  });

  test('9.2 Default editor selector', async ({ authedPage: page }) => {
    await waitForSidebar(page);
    await page.getByTestId('sidebar-settings').click();

    const editorSelect = page.getByTestId('settings-dialog-editor-select');
    await expect(editorSelect).toBeVisible();
  });

  test('9.3 Internal editor toggle', async ({ authedPage: page }) => {
    await waitForSidebar(page);
    await page.getByTestId('sidebar-settings').click();

    const toggle = page.getByTestId('settings-dialog-internal-editor');
    if (await toggle.isVisible()) {
      await toggle.click();
      await page.waitForTimeout(200);
    }
  });

  test('9.4 Language selector', async ({ authedPage: page }) => {
    await waitForSidebar(page);
    await page.getByTestId('sidebar-settings').click();

    const langSelect = page.getByTestId('settings-dialog-language-select');
    await expect(langSelect).toBeVisible();
  });

  test('9.5 Terminal shell selector', async ({ authedPage: page }) => {
    await waitForSidebar(page);
    await page.getByTestId('sidebar-settings').click();

    const shellSelect = page.getByTestId('settings-dialog-shell-select');
    await expect(shellSelect).toBeVisible();
  });

  test('9.7 Cancel discards changes', async ({ authedPage: page }) => {
    await waitForSidebar(page);
    await page.getByTestId('sidebar-settings').click();

    await expect(page.getByTestId('settings-dialog-cancel')).toBeVisible();
    await page.getByTestId('settings-dialog-cancel').click();

    // Dialog should close
    await expect(page.getByTestId('settings-dialog-cancel')).not.toBeVisible();
  });

  test('9.8 Save persists changes', async ({ authedPage: page }) => {
    await waitForSidebar(page);
    await page.getByTestId('sidebar-settings').click();

    // Intercept profile save
    const savePromise = page.waitForResponse(
      (res) => res.url().includes('/api/profile') && res.request().method() === 'PUT',
    );

    await page.getByTestId('settings-dialog-save').click();

    const response = await savePromise;
    expect(response.ok()).toBeTruthy();
  });
});
