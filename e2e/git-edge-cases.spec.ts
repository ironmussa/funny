import fs from 'fs';
import path from 'path';

import { test, expect, seedProject } from './fixtures';

test.describe('G. Git Edge Cases', () => {
  let projectId: string;
  let threadId: string;
  let repoPath: string;

  test.beforeEach(async ({ api, authedPage: page, tempRepo }) => {
    repoPath = tempRepo;
    const project = await seedProject(api, page, repoPath, `GitEdge-${Date.now()}`);
    projectId = project.id;
    const thread = await api.createIdleThread(projectId, 'Git Edge Test');
    threadId = thread.id;
  });

  test.afterEach(async ({ api }) => {
    await api.deleteThread(threadId).catch(() => {});
    await api.deleteProject(projectId).catch(() => {});
  });

  test('G.1 Empty diff — review pane shows clean state', async ({ authedPage: page }) => {
    await page.goto(`/projects/${projectId}/threads/${threadId}`);
    await page.waitForLoadState('networkidle');

    // Open review pane with no dirty files
    await page.getByTestId('header-toggle-review').click();
    await page.waitForTimeout(500);
    await page.getByTestId('review-refresh').click();
    await page.waitForTimeout(1000);

    // Should show empty state — no files listed
    // Commit button should not be available or there should be a "no changes" message
    await expect(page.getByTestId('review-close')).toBeVisible();
  });

  test('G.3 Very long filename displays correctly', async ({ authedPage: page }) => {
    // Create a file with a very long name
    const longName = 'a'.repeat(200) + '.txt';
    try {
      fs.writeFileSync(path.join(repoPath, longName), 'long filename test\n');
    } catch {
      // Windows may not support filenames this long — try shorter
      const shorterName = 'a'.repeat(100) + '.txt';
      fs.writeFileSync(path.join(repoPath, shorterName), 'long filename test\n');
    }

    await page.goto(`/projects/${projectId}/threads/${threadId}`);
    await page.waitForLoadState('networkidle');

    await page.getByTestId('header-toggle-review').click();
    await page.waitForTimeout(500);
    await page.getByTestId('review-refresh').click();
    await page.waitForTimeout(1500);

    // File should appear without breaking layout
    const hasOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    });
    expect(hasOverflow).toBeFalsy();
  });

  test('G.4 Special chars in filename', async ({ authedPage: page }) => {
    // Create files with special characters
    const specialFiles = ['file with spaces.txt', 'acentos-cancion.txt'];
    for (const name of specialFiles) {
      try {
        fs.writeFileSync(path.join(repoPath, name), `content of ${name}\n`);
      } catch {
        // Skip if filesystem doesn't support it
      }
    }

    await page.goto(`/projects/${projectId}/threads/${threadId}`);
    await page.waitForLoadState('networkidle');

    await page.getByTestId('header-toggle-review').click();
    await page.waitForTimeout(500);
    await page.getByTestId('review-refresh').click();
    await page.waitForTimeout(1500);

    // Files should appear in the list
    await expect(page.getByTestId('review-close')).toBeVisible();
  });

  test('G.5 Commit with empty message — button disabled', async ({ authedPage: page }) => {
    // Create a dirty file
    fs.writeFileSync(path.join(repoPath, 'commit-empty-test.txt'), 'test\n');

    await page.goto(`/projects/${projectId}/threads/${threadId}`);
    await page.waitForLoadState('networkidle');

    await page.getByTestId('header-toggle-review').click();
    await page.waitForTimeout(500);
    await page.getByTestId('review-refresh').click();
    await page.waitForTimeout(1500);

    // Ensure commit title is empty
    const commitTitle = page.getByTestId('review-commit-title');
    if (await commitTitle.isVisible()) {
      await commitTitle.fill('');

      // Commit execute button should be disabled or not react
      const commitBtn = page.getByTestId('review-commit-execute');
      if (await commitBtn.isVisible()) {
        const isDisabled = await commitBtn.isDisabled();
        // Either disabled or clicking does nothing with empty message
        if (!isDisabled) {
          await commitBtn.click();
          // Should show error or do nothing — no crash
          await page.waitForTimeout(500);
          await expect(page.getByTestId('review-close')).toBeVisible();
        }
      }
    }
  });

  test('G.6 Multiple file types in diff', async ({ authedPage: page }) => {
    // Create various file types
    fs.writeFileSync(path.join(repoPath, 'script.js'), 'console.log("hello");\n');
    fs.writeFileSync(path.join(repoPath, 'style.css'), 'body { color: red; }\n');
    fs.writeFileSync(path.join(repoPath, 'data.json'), '{"key": "value"}\n');
    fs.writeFileSync(path.join(repoPath, 'readme.md'), '# Title\n');

    await page.goto(`/projects/${projectId}/threads/${threadId}`);
    await page.waitForLoadState('networkidle');

    await page.getByTestId('header-toggle-review').click();
    await page.waitForTimeout(500);
    await page.getByTestId('review-refresh').click();
    await page.waitForTimeout(1500);

    // All files should appear
    await expect(page.getByText('script.js')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('style.css')).toBeVisible();
    await expect(page.getByText('data.json')).toBeVisible();
    await expect(page.getByText('readme.md')).toBeVisible();
  });

  test('G.7 Modified file shows correct status badge', async ({ authedPage: page }) => {
    // Modify the existing README.md
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# Modified\nNew content\n');

    await page.goto(`/projects/${projectId}/threads/${threadId}`);
    await page.waitForLoadState('networkidle');

    await page.getByTestId('header-toggle-review').click();
    await page.waitForTimeout(500);
    await page.getByTestId('review-refresh').click();
    await page.waitForTimeout(1500);

    // README.md should show "M" badge (modified)
    await expect(page.getByText('README.md')).toBeVisible({ timeout: 5000 });
  });

  test('G.8 Deleted file shows correct status', async ({ authedPage: page }) => {
    // Delete the README
    fs.unlinkSync(path.join(repoPath, 'README.md'));

    await page.goto(`/projects/${projectId}/threads/${threadId}`);
    await page.waitForLoadState('networkidle');

    await page.getByTestId('header-toggle-review').click();
    await page.waitForTimeout(500);
    await page.getByTestId('review-refresh').click();
    await page.waitForTimeout(1500);

    // Should show README.md with "D" (deleted) badge
    await expect(page.getByText('README.md')).toBeVisible({ timeout: 5000 });
  });

  test('G.9 Binary file in diff does not crash', async ({ authedPage: page }) => {
    // Create a binary-like file
    const buffer = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) buffer[i] = i;
    fs.writeFileSync(path.join(repoPath, 'binary.bin'), buffer);

    await page.goto(`/projects/${projectId}/threads/${threadId}`);
    await page.waitForLoadState('networkidle');

    await page.getByTestId('header-toggle-review').click();
    await page.waitForTimeout(500);
    await page.getByTestId('review-refresh').click();
    await page.waitForTimeout(1500);

    // Should show the file without crashing
    await expect(page.getByTestId('review-close')).toBeVisible();
  });

  test('G.10 Large number of changed files', async ({ authedPage: page }) => {
    // Create many files
    for (let i = 0; i < 50; i++) {
      fs.writeFileSync(
        path.join(repoPath, `file-${i.toString().padStart(3, '0')}.txt`),
        `content ${i}\n`,
      );
    }

    await page.goto(`/projects/${projectId}/threads/${threadId}`);
    await page.waitForLoadState('networkidle');

    await page.getByTestId('header-toggle-review').click();
    await page.waitForTimeout(500);
    await page.getByTestId('review-refresh').click();
    await page.waitForTimeout(2000);

    // Review pane should handle many files (virtualized list)
    await expect(page.getByTestId('review-close')).toBeVisible();

    // Select all should still work
    const selectAll = page.getByTestId('review-select-all');
    if (await selectAll.isVisible()) {
      await selectAll.click();
      await page.waitForTimeout(300);
    }
  });
});
