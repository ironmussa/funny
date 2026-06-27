import { test, expect, waitForSidebar } from './fixtures';

test.describe('1. Authentication & Bootstrap', () => {
  test('1.1 App requires login before showing the sidebar', async ({ page }) => {
    await page.goto('/');

    await expect(page.locator('#username')).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();
    await expect(page.getByTestId('sidebar-settings')).not.toBeVisible();
  });

  test('1.2 Bootstrap fetch reports deployment mode', async ({ request, baseURL }) => {
    const response = await request.get(`${baseURL}/api/bootstrap`);
    expect(response.ok()).toBeTruthy();
    const body = await response.json();

    expect(['team', 'standalone']).toContain(body.mode);
  });

  test('1.9 Auth gate shows skeleton during bootstrap', async ({ page }) => {
    // Slow down the bootstrap response to catch the skeleton
    await page.route('**/api/bootstrap', async (route) => {
      await new Promise((r) => setTimeout(r, 1000));
      await route.continue();
    });

    await page.goto('/');

    await expect(page.locator('#username')).toBeVisible();
  });

  test('1.7 Logout button is shown after login', async ({ authedPage: page }) => {
    await waitForSidebar(page);

    await page.getByTestId('sidebar-user-menu').click();
    await expect(page.getByTestId('sidebar-logout')).toBeVisible();
  });
});
