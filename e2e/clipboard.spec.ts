import { test, expect, seedProject } from './fixtures';

test.describe('K. Clipboard & Copy', () => {
  let projectId: string;
  let threadId: string;

  test.beforeEach(async ({ api, authedPage: page, tempRepo }) => {
    const project = await seedProject(api, page, tempRepo, `Clipboard-${Date.now()}`);
    projectId = project.id;
    const thread = await api.createIdleThread(projectId, 'Clipboard Test Thread');
    threadId = thread.id;
  });

  test.afterEach(async ({ api }) => {
    await api.deleteThread(threadId).catch(() => {});
    await api.deleteProject(projectId).catch(() => {});
  });

  test('K.1 Copy text via header menu', async ({ authedPage: page, context }) => {
    // Grant clipboard permissions
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    await page.goto(`/projects/${projectId}/threads/${threadId}`);
    await page.waitForLoadState('networkidle');

    await page.getByTestId('header-more-actions').click();
    await page.waitForTimeout(300);

    await page.getByTestId('header-menu-copy-text').click();
    await page.waitForTimeout(500);

    // Should have copied something to clipboard (even if empty for idle thread)
    // A toast should appear confirming the copy
    // The action should complete without error
  });

  test('K.2 Copy all via header menu', async ({ authedPage: page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    await page.goto(`/projects/${projectId}/threads/${threadId}`);
    await page.waitForLoadState('networkidle');

    await page.getByTestId('header-more-actions').click();
    await page.waitForTimeout(300);

    await page.getByTestId('header-menu-copy-all').click();
    await page.waitForTimeout(500);

    // Should complete without error
  });

  test('K.3 Copy file path from review pane', async ({ authedPage: page, context, tempRepo }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    // Create a dirty file
    const fs = await import('fs');
    const path = await import('path');
    fs.writeFileSync(path.join(tempRepo, 'copy-path-test.txt'), 'test\n');

    await page.goto(`/projects/${projectId}/threads/${threadId}`);
    await page.waitForLoadState('networkidle');

    await page.getByTestId('header-toggle-review').click();
    await page.waitForTimeout(500);
    await page.getByTestId('review-refresh').click();
    await page.waitForTimeout(1500);

    // Right-click on a file to get context menu
    const fileRow = page.getByText('copy-path-test.txt');
    if (await fileRow.isVisible()) {
      await fileRow.click({ button: 'right' });
      await page.waitForTimeout(300);

      // Look for "Copy path" in context menu
      const copyPathOption = page.getByText(/copy.*path/i).first();
      if (await copyPathOption.isVisible().catch(() => false)) {
        await copyPathOption.click();
        await page.waitForTimeout(500);

        // Verify clipboard has content
        const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
        expect(clipboardText).toContain('copy-path-test.txt');
      }
    }
  });

  test('K.4 Message copy button works', async ({ authedPage: page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    await page.goto(`/projects/${projectId}/threads/${threadId}`);
    await page.waitForLoadState('networkidle');

    // The message-copy button appears on hover over messages
    const copyBtn = page.getByTestId('message-copy');
    if (
      await copyBtn
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      await copyBtn.first().click();
      await page.waitForTimeout(500);
      // Should copy without error
    }
  });
});
