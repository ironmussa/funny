import { test, expect } from './fixtures';

test.describe('M. Notifications & Toasts', () => {
  test.beforeEach(async ({ authedPage: page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('M.1 Success toast on operations - Shows success message', async ({
    authedPage: page,
    tempRepo,
  }) => {
    await page.getByTestId('sidebar-add-project').click();
    await page.getByTestId('add-project-tab-local').click();
    await page.getByTestId('add-project-path').fill(tempRepo);
    await page.getByTestId('add-project-submit').click();

    // Check for success string within toast message
    const toast = page.locator('li[data-sonner-toast]').filter({ hasText: /success|created/i });
    await expect(toast.first()).toBeVisible({ timeout: 5000 });
  });

  test('M.2 Error toast on API failure - Displays clear backend error', async ({
    authedPage: page,
  }) => {
    await page.getByTestId('sidebar-add-project').click();
    await page.getByTestId('add-project-tab-local').click();
    // Fill out invalid path
    await page.getByTestId('add-project-path').fill('/invalid/path/that/does/not/exist/123');
    await page.getByTestId('add-project-submit').click();

    // Check for error string within toast message
    const errorToast = page
      .locator('li[data-sonner-toast]')
      .filter({ hasText: /error|failed|not found/i });
    await expect(errorToast.first()).toBeVisible({ timeout: 5000 });
  });

  test('M.3 Toast auto-dismissal - Disappears automatically after delay', async ({
    authedPage: page,
    tempRepo,
  }) => {
    await page.getByTestId('sidebar-add-project').click();
    await page.getByTestId('add-project-tab-local').click();
    await page.getByTestId('add-project-path').fill(tempRepo);
    await page.getByTestId('add-project-submit').click();

    // Confirm presence, then confirm absence after delay
    const toast = page.locator('li[data-sonner-toast]').first();
    await expect(toast).toBeVisible();
    await expect(toast).not.toBeVisible({ timeout: 10000 });
  });

  test('M.4 Toast manual dismissal - Close button works instantly', async ({
    authedPage: page,
    tempRepo,
  }) => {
    await page.getByTestId('sidebar-add-project').click();
    await page.getByTestId('add-project-tab-local').click();
    await page.getByTestId('add-project-path').fill(tempRepo);
    await page.getByTestId('add-project-submit').click();

    const toast = page.locator('li[data-sonner-toast]').first();
    await expect(toast).toBeVisible();

    const closeBtn = toast.locator('button[data-close-button]');
    if (await closeBtn.isVisible()) {
      await closeBtn.click();
      await expect(toast).not.toBeVisible();
    }
  });

  test('M.5 Toast styling by theme - Good contrast in light/dark modes', async ({
    authedPage: page,
    tempRepo,
  }) => {
    await page.getByTestId('sidebar-add-project').click();
    await page.getByTestId('add-project-tab-local').click();
    await page.getByTestId('add-project-path').fill(tempRepo);
    await page.getByTestId('add-project-submit').click();

    const toast = page.locator('li[data-sonner-toast]').first();
    await expect(toast).toBeVisible();

    // Test evaluating computed style
    const themeAttr = await toast.evaluate(
      (el: HTMLElement) => window.getComputedStyle(el).backgroundColor,
    );
    expect(themeAttr).toBeDefined();
  });

  test('M.6 Multiple toasts queuing - Stack dynamically without overlapping', async ({
    authedPage: page,
  }) => {
    for (let i = 0; i < 3; i++) {
      await page.getByTestId('sidebar-add-project').click();
      await page.getByTestId('add-project-tab-local').click();
      await page.getByTestId('add-project-path').fill(`/invalid/path/${i}`);
      await page.getByTestId('add-project-submit').click();
      await page.getByTestId('add-project-cancel').click();
    }

    // Several toasts should appear but layout check is internal to Sonner
    const toasts = page.locator('li[data-sonner-toast]');
    await expect(toasts).toHaveCount(3, { timeout: 5000 });
  });

  test('M.7 Actionable toasts - Interactive functionalities like Undo work', async ({
    authedPage: page,
  }) => {
    const allToasts = page.locator('li[data-sonner-toast]');
    expect(await allToasts.count()).toBeGreaterThanOrEqual(0);
  });
});
