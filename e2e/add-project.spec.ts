import fs from 'fs';
import path from 'path';

import { test, expect, waitForSidebar, removeTempDir } from './fixtures';

test.describe('3. Project Management (AddProjectView)', () => {
  test('3.1 Local folder tab renders with fields', async ({ authedPage: page }) => {
    await page.goto('/new');
    await page.waitForLoadState('networkidle');

    // Local tab should be active by default
    await expect(page.getByTestId('add-project-tab-local')).toBeVisible();
    await expect(page.getByTestId('add-project-tab-clone')).toBeVisible();

    // Fields should be visible
    await expect(page.getByTestId('add-project-name')).toBeVisible();
    await expect(page.getByTestId('add-project-path')).toBeVisible();
    await expect(page.getByTestId('add-project-browse')).toBeVisible();

    // Buttons
    await expect(page.getByTestId('add-project-cancel')).toBeVisible();
    await expect(page.getByTestId('add-project-submit')).toBeVisible();
  });

  test('3.2 Auto-fill project name from git repo path', async ({ authedPage: page, tempRepo }) => {
    await page.goto('/new');
    await page.waitForLoadState('networkidle');

    // Fill the path input
    await page.getByTestId('add-project-path').fill(tempRepo);

    // Wait for auto-fill of project name (it calls /api/browse/repo-name)
    await page.waitForTimeout(1000);

    // The name field should be auto-populated (with the repo dir name)
    const nameValue = await page.getByTestId('add-project-name').inputValue();
    expect(nameValue.length).toBeGreaterThan(0);
  });

  test('3.4 Add project with valid git repo', async ({ authedPage: page, api, tempRepo }) => {
    await page.goto('/new');
    await page.waitForLoadState('networkidle');

    const projectName = `E2E-Project-${Date.now()}`;

    // Fill fields
    await page.getByTestId('add-project-name').fill(projectName);
    await page.getByTestId('add-project-path').fill(tempRepo);

    // Submit
    await page.getByTestId('add-project-submit').click();

    // Should navigate away from /new
    await page.waitForURL((url) => !url.pathname.includes('/new'), { timeout: 10000 });

    // Project should appear in sidebar
    await waitForSidebar(page);
    await expect(page.getByText(projectName)).toBeVisible();

    // Cleanup
    const projects = await api.getProjects();
    const created = projects.find((p) => p.name === projectName);
    if (created) await api.deleteProject(created.id);
  });

  test('3.5 Add project with non-git path shows git init dialog', async ({ authedPage: page }) => {
    const tmpBase = process.env.TEMP || process.env.TMP || 'C:\\Temp';
    const nonGitDir = path.join(tmpBase, `funny-e2e-nongit-${Date.now()}`);
    fs.mkdirSync(nonGitDir, { recursive: true });

    try {
      await page.goto('/new');
      await page.waitForLoadState('networkidle');

      await page.getByTestId('add-project-name').fill('Non-Git Project');
      await page.getByTestId('add-project-path').fill(nonGitDir);

      await page.getByTestId('add-project-submit').click();

      // Should show git init dialog
      await expect(page.getByTestId('git-init-confirm')).toBeVisible({ timeout: 5000 });
      await expect(page.getByTestId('git-init-cancel')).toBeVisible();
    } finally {
      removeTempDir(nonGitDir);
    }
  });

  test('3.6 Cancel add project navigates to /', async ({ authedPage: page }) => {
    await page.goto('/new');
    await page.waitForLoadState('networkidle');

    await page.getByTestId('add-project-cancel').click();

    await expect(page).toHaveURL(/\/$/);
  });

  test('3.7 GitHub clone tab renders', async ({ authedPage: page }) => {
    await page.goto('/new');
    await page.waitForLoadState('networkidle');

    // Switch to clone tab
    await page.getByTestId('add-project-tab-clone').click();

    // Should show GitHub-related content (connection status)
    await page.waitForTimeout(500);
    // The clone view should be visible (different content than local tab)
    await expect(page.getByTestId('add-project-name')).not.toBeVisible();
  });

  test('3.8 Git init cancel closes dialog', async ({ authedPage: page }) => {
    const tmpBase = process.env.TEMP || process.env.TMP || 'C:\\Temp';
    const nonGitDir = path.join(tmpBase, `funny-e2e-nongit2-${Date.now()}`);
    fs.mkdirSync(nonGitDir, { recursive: true });

    try {
      await page.goto('/new');
      await page.waitForLoadState('networkidle');

      await page.getByTestId('add-project-name').fill('Non-Git Project 2');
      await page.getByTestId('add-project-path').fill(nonGitDir);

      await page.getByTestId('add-project-submit').click();

      // Wait for git init dialog
      await expect(page.getByTestId('git-init-cancel')).toBeVisible({ timeout: 5000 });

      // Cancel should close dialog
      await page.getByTestId('git-init-cancel').click();
      await expect(page.getByTestId('git-init-cancel')).not.toBeVisible();

      // Should still be on /new
      await expect(page).toHaveURL(/\/new/);
    } finally {
      removeTempDir(nonGitDir);
    }
  });
});
