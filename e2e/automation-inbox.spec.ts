import { test, expect, waitForSidebar } from './fixtures';

test.describe('14. Automation Inbox', () => {
  test('14.1 Inbox renders', async ({ authedPage: page }) => {
    await page.goto('/inbox');
    await page.waitForLoadState('networkidle');

    // Search should be visible
    await expect(page.getByTestId('inbox-search')).toBeVisible();
  });

  test('14.2 Manage automations link', async ({ authedPage: page }) => {
    await page.goto('/inbox');
    await page.waitForLoadState('networkidle');

    const manageBtn = page.getByTestId('inbox-manage-automations');
    if (await manageBtn.isVisible()) {
      await manageBtn.click();
      await expect(page).toHaveURL(/settings\/automations/);
    }
  });

  test('14.3 Tab filter by status', async ({ authedPage: page }) => {
    await page.goto('/inbox');
    await page.waitForLoadState('networkidle');

    // Click each tab
    const statuses = ['pending', 'reviewed', 'dismissed'];
    for (const status of statuses) {
      const tab = page.getByTestId(`inbox-tab-${status}`);
      if (await tab.isVisible()) {
        await tab.click();
        await page.waitForTimeout(300);
      }
    }
  });

  test('14.4 Search automation results', async ({ authedPage: page }) => {
    await page.goto('/inbox');
    await page.waitForLoadState('networkidle');

    const search = page.getByTestId('inbox-search');
    await search.fill('test automation');
    await page.waitForTimeout(500);

    // Clear search
    await search.fill('');
  });

  test('14.5 Project filter', async ({ authedPage: page }) => {
    await page.goto('/inbox');
    await page.waitForLoadState('networkidle');

    const filter = page.getByTestId('inbox-project-filter');
    if (await filter.isVisible()) {
      await filter.click();
      await page.waitForTimeout(300);
    }
  });

  test('14.1b Navigate to inbox via sidebar', async ({ authedPage: page }) => {
    await waitForSidebar(page);

    // Find and click the Automation Inbox button in the sidebar
    const inboxLink = page.getByText('Automation Inbox');
    if (await inboxLink.isVisible().catch(() => false)) {
      await inboxLink.click();
      await expect(page).toHaveURL(/\/inbox/);
    }
  });
});
