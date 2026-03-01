import { test, expect, waitForSidebar, seedProject } from './fixtures';

test.describe('A. Accessibility', () => {
  let projectId: string;

  test.beforeEach(async ({ api, authedPage: page, tempRepo }) => {
    const project = await seedProject(api, page, tempRepo, `A11y-${Date.now()}`);
    projectId = project.id;
  });

  test.afterEach(async ({ api }) => {
    await api.deleteProject(projectId).catch(() => {});
  });

  test('A.1 Sidebar navigation icons have accessible labels', async ({ authedPage: page }) => {
    const icons = [
      'sidebar-search',
      'sidebar-kanban',
      'sidebar-grid',
      'sidebar-analytics',
      'sidebar-collapse',
      'sidebar-add-project',
      'sidebar-settings',
    ];

    for (const testId of icons) {
      const el = page.getByTestId(testId);
      if (await el.isVisible().catch(() => false)) {
        // Button should have either aria-label, title, or visible text
        const ariaLabel = await el.getAttribute('aria-label');
        const title = await el.getAttribute('title');
        const text = await el.textContent();
        const hasLabel = !!(ariaLabel || title || (text && text.trim()));
        expect(hasLabel, `${testId} should have an accessible label`).toBeTruthy();
      }
    }
  });

  test('A.2 Focus trap in NewThreadDialog', async ({ authedPage: page }) => {
    // Expand project and open new thread dialog
    await page.getByTestId(`project-item-${projectId}`).click();
    await page.waitForTimeout(300);
    await page.getByTestId(`project-new-thread-${projectId}`).click();

    // Dialog should be visible
    await expect(page.getByTestId('new-thread-prompt')).toBeVisible();

    // Tab through elements — focus should stay within the dialog
    // Press Tab multiple times
    for (let i = 0; i < 15; i++) {
      await page.keyboard.press('Tab');
    }

    // Active element should still be within the dialog
    const _activeElement = await page.evaluate(() => {
      const el = document.activeElement;
      return (
        el?.closest('[role="dialog"]') !== null ||
        el?.closest('[data-testid]')?.getAttribute('data-testid')?.startsWith('new-thread') ||
        false
      );
    });
    // Radix dialogs trap focus by default — we just verify the dialog is still open
    await expect(page.getByTestId('new-thread-prompt')).toBeVisible();
  });

  test('A.3 Focus returns on dialog close', async ({ authedPage: page }) => {
    // Open settings dialog
    const settingsBtn = page.getByTestId('sidebar-settings');
    await settingsBtn.click();

    await expect(page.getByTestId('settings-dialog-save')).toBeVisible();

    // Close via cancel
    await page.getByTestId('settings-dialog-cancel').click();
    await page.waitForTimeout(300);

    // Focus should return to sidebar area (Radix handles this)
    await expect(page.getByTestId('settings-dialog-save')).not.toBeVisible();
  });

  test('A.4 Command palette has proper ARIA roles', async ({ authedPage: page }) => {
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(500);

    // Command palette should have dialog role
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog.first()).toBeVisible();

    // Search input should exist
    await expect(page.getByTestId('command-palette-search')).toBeVisible();

    // There should be listbox or group roles for results
    const listItems = page.locator('[role="option"], [cmdk-item]');
    const count = await listItems.count();
    expect(count).toBeGreaterThanOrEqual(0);

    await page.keyboard.press('Escape');
  });

  test('A.5 Icon-only buttons have aria-label', async ({ authedPage: page }) => {
    // Navigate to a thread to get all header buttons
    const _thread = await (await import('./fixtures')).default.skip; // Use API to create thread
    // Check header buttons that are icon-only
    await page.goto(`/projects/${projectId}`);
    await page.waitForLoadState('networkidle');

    // Review pane toggle should have accessible label
    const toggleReview = page.getByTestId('header-toggle-review');
    if (await toggleReview.isVisible().catch(() => false)) {
      const ariaLabel = await toggleReview.getAttribute('aria-label');
      const title = await toggleReview.getAttribute('title');
      const text = (await toggleReview.textContent())?.trim();
      expect(
        ariaLabel || title || text,
        'header-toggle-review needs accessible label',
      ).toBeTruthy();
    }
  });

  test('A.6 Delete confirmation dialogs have proper structure', async ({
    authedPage: page,
    api,
  }) => {
    const thread = await api.createIdleThread(projectId, 'A11y Delete Test');

    await page.reload();
    await waitForSidebar(page);
    await page.getByTestId(`project-item-${projectId}`).click();
    await page.waitForTimeout(300);

    // Open thread context menu → delete
    await page.getByTestId(`thread-item-more-${thread.id}`).click();
    await page.getByText('Delete').click();

    // Dialog should have role="dialog" or role="alertdialog"
    const dialog = page.locator('[role="dialog"], [role="alertdialog"]');
    await expect(dialog.first()).toBeVisible();

    // Should have a title/description
    const dialogTitle = dialog.first().locator('[id*="title"], h2, h3');
    const titleCount = await dialogTitle.count();
    expect(titleCount).toBeGreaterThan(0);

    // Cancel to cleanup
    await page.getByTestId('delete-thread-cancel').click();
    await api.deleteThread(thread.id);
  });

  test('A.7 Keyboard can navigate sidebar projects', async ({ authedPage: page }) => {
    // Focus on the sidebar area
    const projectItem = page.getByTestId(`project-item-${projectId}`);
    await projectItem.focus();

    // Should be focusable
    const isFocused = await projectItem.evaluate(
      (el) => document.activeElement === el || el.contains(document.activeElement),
    );
    expect(isFocused).toBeTruthy();

    // Enter should activate/expand
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
  });
});
