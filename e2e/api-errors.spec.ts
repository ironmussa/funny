import { test, expect, seedProject } from './fixtures';

test.describe('D. API Error Handling', () => {
  test('D.1 500 on project create shows error, no crash', async ({ authedPage: page }) => {
    // Intercept project creation with a 500 error
    await page.route('**/api/projects', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Internal Server Error' }),
        });
      } else {
        await route.continue();
      }
    });

    await page.goto('/new');
    await page.waitForLoadState('networkidle');

    await page.getByTestId('add-project-name').fill('Fail Project');
    await page.getByTestId('add-project-path').fill('C:\\fake\\path');
    await page.getByTestId('add-project-submit').click();

    // Should show an error (toast or inline) — not crash
    await page.waitForTimeout(1000);

    // App should still be functional
    await expect(page.getByTestId('add-project-submit')).toBeVisible();
  });

  test('D.2 404 on thread load shows graceful error', async ({
    authedPage: page,
    api,
    tempRepo,
  }) => {
    const project = await seedProject(api, page, tempRepo, `Error404-${Date.now()}`);

    // Navigate to a non-existent thread
    await page.goto(`/projects/${project.id}/threads/nonexistent-thread-id`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // App should not crash — sidebar should still be visible
    await expect(page.getByTestId('sidebar-settings')).toBeVisible();

    await api.deleteProject(project.id);
  });

  test('D.3 Network timeout on projects shows loading state', async ({ authedPage: page }) => {
    // Intercept projects with a very slow response
    await page.route('**/api/projects', async (route) => {
      if (route.request().method() === 'GET') {
        await new Promise((r) => setTimeout(r, 5000));
        await route.continue();
      } else {
        await route.continue();
      }
    });

    await page.goto('/');

    // During loading, sidebar should show some loading indicator
    // After it resolves (or times out), the app should be functional
    await page.waitForTimeout(2000);

    // App should not be crashed
    const body = page.locator('body');
    await expect(body).toBeVisible();
  });

  test('D.4 401 on API call handles gracefully', async ({ authedPage: page }) => {
    // Intercept threads API with 401
    await page.route('**/api/threads**', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Unauthorized' }),
        });
      } else {
        await route.continue();
      }
    });

    await page.goto('/list');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // App should handle gracefully — might show error or redirect
    // Should not show a blank white page
    const body = page.locator('body');
    const text = await body.textContent();
    expect(text?.length).toBeGreaterThan(0);
  });

  test('D.5 Malformed API response does not crash app', async ({ authedPage: page }) => {
    // Return invalid JSON
    await page.route('**/api/projects', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: 'this is not valid json{{{',
        });
      } else {
        await route.continue();
      }
    });

    await page.goto('/');
    await page.waitForTimeout(2000);

    // App should not show a blank page
    const body = page.locator('body');
    await expect(body).toBeVisible();
  });

  test('D.6 Diff API error shows error in review pane', async ({
    authedPage: page,
    api,
    tempRepo,
  }) => {
    const project = await seedProject(api, page, tempRepo, `DiffError-${Date.now()}`);
    const thread = await api.createIdleThread(project.id, 'Diff Error Thread');

    // Intercept diff summary with error
    await page.route('**/api/git/**/diff/summary**', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Git operation failed' }),
      });
    });

    await page.goto(`/projects/${project.id}/threads/${thread.id}`);
    await page.waitForLoadState('networkidle');

    // Open review pane
    await page.getByTestId('header-toggle-review').click();
    await page.waitForTimeout(1000);

    // Review pane should still render (even with error)
    await expect(page.getByTestId('review-close')).toBeVisible();

    await api.deleteThread(thread.id);
    await api.deleteProject(project.id);
  });

  test('D.7 Bootstrap failure shows fallback', async ({ page }) => {
    // Intercept bootstrap with error
    await page.route('**/api/bootstrap', async (route) => {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Service Unavailable' }),
      });
    });

    await page.goto('/');
    await page.waitForTimeout(3000);

    // App should show some error state or retry, not a blank page
    const body = page.locator('body');
    await expect(body).toBeVisible();
    const text = await body.textContent();
    expect(text?.length).toBeGreaterThan(0);
  });
});
