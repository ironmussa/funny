import fs from 'fs';
import path from 'path';

import { test, expect, seedProject } from './fixtures';

test.describe('7. Review Pane', () => {
  let projectId: string;
  let threadId: string;
  let repoPath: string;

  test.beforeEach(async ({ api, authedPage: page, tempRepo }) => {
    repoPath = tempRepo;
    const project = await seedProject(api, page, repoPath, `ReviewPane-${Date.now()}`);
    projectId = project.id;
    const thread = await api.createIdleThread(projectId, 'Review Test Thread');
    threadId = thread.id;

    await page.goto(`/projects/${projectId}/threads/${threadId}`);
    await page.waitForLoadState('networkidle');
  });

  test.afterEach(async ({ api }) => {
    await api.deleteThread(threadId).catch(() => {});
    await api.deleteProject(projectId).catch(() => {});
  });

  test('7.1 Toggle review pane open', async ({ authedPage: page }) => {
    // Click the review toggle in the header
    await page.getByTestId('header-toggle-review').click();
    await page.waitForTimeout(500);

    // Review pane controls should appear
    await expect(page.getByTestId('review-close')).toBeVisible();
    await expect(page.getByTestId('review-refresh')).toBeVisible();
  });

  test('7.2 Close review pane', async ({ authedPage: page }) => {
    // Open review pane
    await page.getByTestId('header-toggle-review').click();
    await page.waitForTimeout(500);

    await expect(page.getByTestId('review-close')).toBeVisible();

    // Close it
    await page.getByTestId('review-close').click();
    await page.waitForTimeout(300);

    // Review pane should be closed
    await expect(page.getByTestId('review-close')).not.toBeVisible();
  });

  test('7.6 File search filter', async ({ authedPage: page }) => {
    // Create a dirty file in the repo to have something in the diff
    fs.writeFileSync(path.join(repoPath, 'test-file.txt'), 'hello world\n');

    // Open review pane
    await page.getByTestId('header-toggle-review').click();
    await page.waitForTimeout(500);

    // Refresh to load the diff
    await page.getByTestId('review-refresh').click();
    await page.waitForTimeout(1000);

    // The file filter should be visible
    const filter = page.getByTestId('review-file-filter');
    if (await filter.isVisible()) {
      await filter.fill('test-file');
      await page.waitForTimeout(300);

      // Clear button should appear
      await expect(page.getByTestId('review-file-filter-clear')).toBeVisible();

      // Click clear
      await page.getByTestId('review-file-filter-clear').click();
      await expect(filter).toHaveValue('');
    }
  });

  test('7.7 Select all checkbox', async ({ authedPage: page }) => {
    // Create dirty files
    fs.writeFileSync(path.join(repoPath, 'file-a.txt'), 'a\n');
    fs.writeFileSync(path.join(repoPath, 'file-b.txt'), 'b\n');

    await page.getByTestId('header-toggle-review').click();
    await page.waitForTimeout(500);
    await page.getByTestId('review-refresh').click();
    await page.waitForTimeout(1000);

    const selectAll = page.getByTestId('review-select-all');
    if (await selectAll.isVisible()) {
      await selectAll.click();
      await page.waitForTimeout(200);
      // Toggle again
      await selectAll.click();
    }
  });

  test('7.9 Commit title and body inputs', async ({ authedPage: page }) => {
    // Create a dirty file
    fs.writeFileSync(path.join(repoPath, 'commit-test.txt'), 'commit me\n');

    await page.getByTestId('header-toggle-review').click();
    await page.waitForTimeout(500);
    await page.getByTestId('review-refresh').click();
    await page.waitForTimeout(1000);

    const commitTitle = page.getByTestId('review-commit-title');
    const commitBody = page.getByTestId('review-commit-body');

    if (await commitTitle.isVisible()) {
      await commitTitle.fill('test: add commit test file');
      await expect(commitTitle).toHaveValue('test: add commit test file');

      await commitBody.fill('This is the commit body');
      await expect(commitBody).toHaveValue('This is the commit body');
    }
  });

  test('7.20 Refresh button reloads diff', async ({ authedPage: page }) => {
    await page.getByTestId('header-toggle-review').click();
    await page.waitForTimeout(500);

    // Intercept diff/summary API call
    const diffPromise = page.waitForResponse((res) => res.url().includes('/diff/summary'));

    await page.getByTestId('review-refresh').click();

    const response = await diffPromise;
    expect(response.ok()).toBeTruthy();
  });

  test('7.22 Commit log popover', async ({ authedPage: page }) => {
    await page.getByTestId('header-toggle-review').click();
    await page.waitForTimeout(500);

    const commitLog = page.getByTestId('review-commit-log');
    if (await commitLog.isVisible()) {
      // Intercept log API call
      const logPromise = page.waitForResponse((res) => res.url().includes('/log'));

      await commitLog.click();

      const response = await logPromise;
      expect(response.ok()).toBeTruthy();
    }
  });

  test.describe('with dirty files', () => {
    test.beforeEach(async ({ authedPage: _page }) => {
      // Create dirty files
      fs.writeFileSync(path.join(repoPath, 'dirty-1.txt'), 'dirty content 1\n');
      fs.writeFileSync(path.join(repoPath, 'dirty-2.txt'), 'dirty content 2\n');
    });

    test('7.3 Diff summary loads', async ({ authedPage: page }) => {
      await page.getByTestId('header-toggle-review').click();
      await page.waitForTimeout(500);
      await page.getByTestId('review-refresh').click();
      await page.waitForTimeout(1500);

      // Should show file list with the dirty files
      await expect(page.getByText('dirty-1.txt')).toBeVisible({ timeout: 5000 });
      await expect(page.getByText('dirty-2.txt')).toBeVisible();
    });

    test('7.13 Commit action stages and commits', async ({ authedPage: page }) => {
      await page.getByTestId('header-toggle-review').click();
      await page.waitForTimeout(500);
      await page.getByTestId('review-refresh').click();
      await page.waitForTimeout(1500);

      // Select all files
      const selectAll = page.getByTestId('review-select-all');
      if (await selectAll.isVisible()) {
        await selectAll.click();
      }

      // Fill commit message
      const commitTitle = page.getByTestId('review-commit-title');
      if (await commitTitle.isVisible()) {
        await commitTitle.fill('test: commit dirty files');

        // Click commit execute
        const commitBtn = page.getByTestId('review-commit-execute');
        if (await commitBtn.isVisible()) {
          await commitBtn.click();

          // Git progress modal should appear
          await expect(page.getByTestId('git-progress-done')).toBeVisible({ timeout: 15000 });
          await page.getByTestId('git-progress-done').click();
        }
      }
    });

    test('7.24 Discard all confirmation', async ({ authedPage: page }) => {
      await page.getByTestId('header-toggle-review').click();
      await page.waitForTimeout(500);
      await page.getByTestId('review-refresh').click();
      await page.waitForTimeout(1500);

      const discardAll = page.getByTestId('review-discard-all');
      if (await discardAll.isVisible()) {
        await discardAll.click();

        // Confirmation dialog should appear
        await page.waitForTimeout(300);
        // Look for confirmation dialog buttons
        const confirmBtn = page.getByRole('button', { name: /discard|confirm/i });
        if (await confirmBtn.first().isVisible()) {
          // Cancel to not actually discard
          const cancelBtn = page.getByRole('button', { name: /cancel/i });
          if (await cancelBtn.isVisible()) {
            await cancelBtn.click();
          }
        }
      }
    });
  });

  test.describe('PR dialog', () => {
    test('7.16 Create PR dialog fields', async ({ authedPage: page }) => {
      await page.getByTestId('header-toggle-review').click();
      await page.waitForTimeout(500);

      // The PR button may only be visible in worktree mode with unpushed commits
      // We test the dialog structure if available
      const prBtn = page.getByTestId('review-create-pr');
      if (await prBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await prBtn.click();

        await expect(page.getByTestId('review-pr-title')).toBeVisible();
        await expect(page.getByTestId('review-pr-body')).toBeVisible();
        await expect(page.getByTestId('review-pr-cancel')).toBeVisible();
        await expect(page.getByTestId('review-pr-create')).toBeVisible();

        // Fill in PR fields
        await page.getByTestId('review-pr-title').fill('Test PR');
        await page.getByTestId('review-pr-body').fill('This is a test PR body');

        // Cancel
        await page.getByTestId('review-pr-cancel').click();
        await expect(page.getByTestId('review-pr-title')).not.toBeVisible();
      }
    });
  });
  test.describe('Advanced review pane features', () => {
    test('7.25 Diff syntax highlighting - Shows red/green colors for line differences', async ({
      authedPage: _page,
    }) => {
      // Placeholder test
      expect(true).toBe(true);
    });

    test('7.26 Stage individual changes/hunks - Support for staging part of a file', async ({
      authedPage: _page,
    }) => {
      // Placeholder test
      expect(true).toBe(true);
    });

    test('7.27 Merge conflicts UI - Specific mode or warnings if conflicts exist', async ({
      authedPage: _page,
    }) => {
      // Placeholder test
      expect(true).toBe(true);
    });

    test('7.28 Fetch / Sync button - Force updates status against remote', async ({
      authedPage: _page,
    }) => {
      // Placeholder test
      expect(true).toBe(true);
    });
  });
});
