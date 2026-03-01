import { test, expect, waitForSidebar, seedProject } from './fixtures';

test.describe('L. Security (Client-Side)', () => {
  let projectId: string;

  test.beforeEach(async ({ api, authedPage: page, tempRepo }) => {
    const project = await seedProject(api, page, tempRepo, `Security-${Date.now()}`);
    projectId = project.id;
  });

  test.afterEach(async ({ api }) => {
    await api.deleteProject(projectId).catch(() => {});
  });

  test('L.1 XSS in project name is escaped', async ({ authedPage: page, api, tempRepo }) => {
    const xssName = '<script>alert("xss")</script>';
    const project = await api.createProject(xssName, tempRepo);

    await page.reload();
    await waitForSidebar(page);
    await page.waitForTimeout(500);

    // The script tag should be rendered as text, not executed
    // Check that no alert dialog appeared
    let alertFired = false;
    page.on('dialog', () => {
      alertFired = true;
    });
    await page.waitForTimeout(1000);
    expect(alertFired).toBeFalsy();

    // The project name should be visible as escaped text
    const bodyText = await page.textContent('body');
    expect(bodyText).not.toContain('<script>');

    await api.deleteProject(project.id);
  });

  test('L.2 XSS in thread title is escaped', async ({ authedPage: page, api }) => {
    const xssTitle = '<img src=x onerror="alert(1)">';
    const thread = await api.createIdleThread(projectId, xssTitle);

    await page.reload();
    await waitForSidebar(page);
    await page.getByTestId(`project-item-${projectId}`).click();
    await page.waitForTimeout(500);

    // No alert should fire
    let alertFired = false;
    page.on('dialog', () => {
      alertFired = true;
    });
    await page.waitForTimeout(1000);
    expect(alertFired).toBeFalsy();

    // Navigate to the thread
    await page.goto(`/projects/${projectId}/threads/${thread.id}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    expect(alertFired).toBeFalsy();

    await api.deleteThread(thread.id);
  });

  test('L.3 XSS in commit message is escaped', async ({ authedPage: page, api }) => {
    const thread = await api.createIdleThread(projectId, 'XSS Commit Thread');

    await page.goto(`/projects/${projectId}/threads/${thread.id}`);
    await page.waitForLoadState('networkidle');

    await page.getByTestId('header-toggle-review').click();
    await page.waitForTimeout(500);

    // Try XSS in commit title
    const commitTitle = page.getByTestId('review-commit-title');
    if (await commitTitle.isVisible()) {
      await commitTitle.fill('<script>alert("xss")</script>');

      let alertFired = false;
      page.on('dialog', () => {
        alertFired = true;
      });
      await page.waitForTimeout(500);
      expect(alertFired).toBeFalsy();
    }

    await api.deleteThread(thread.id);
  });

  test('L.4 XSS in search input is escaped', async ({ authedPage: page }) => {
    await page.goto('/list');
    await page.waitForLoadState('networkidle');

    const search = page.getByTestId('all-threads-search');
    await search.fill('<img src=x onerror="document.title=\'pwned\'">');
    await page.waitForTimeout(1000);

    // Document title should not change
    const title = await page.title();
    expect(title).not.toBe('pwned');
  });

  test('L.5 Auth token not leaked in URL', async ({ authedPage: page }) => {
    await waitForSidebar(page);

    // Navigate through several pages
    const routes = ['/', '/list', '/kanban', '/analytics', '/new'];

    for (const route of routes) {
      await page.goto(route);
      await page.waitForLoadState('domcontentloaded');

      const url = page.url();
      // Token should not be in the URL
      expect(url).not.toContain('token=');
      expect(url).not.toContain('Bearer');
      expect(url).not.toContain('authorization');
    }
  });

  test('L.6 No sensitive data in localStorage', async ({ authedPage: page }) => {
    await waitForSidebar(page);

    const sensitiveKeys = await page.evaluate(() => {
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)!;
        const value = localStorage.getItem(key) || '';

        // Check for common sensitive patterns
        if (
          value.includes('password') ||
          value.includes('secret') ||
          (value.length > 100 && /^[A-Za-z0-9+/=]+$/.test(value)) // Base64-like long strings
        ) {
          keys.push(key);
        }
      }
      return keys;
    });

    expect(
      sensitiveKeys.length,
      `Found potentially sensitive localStorage keys: ${sensitiveKeys.join(', ')}`,
    ).toBe(0);
  });

  test('L.7 XSS in project rename is escaped', async ({ authedPage: page }) => {
    await page.getByTestId(`project-more-actions-${projectId}`).click();
    await page.getByTestId('project-menu-rename').click();

    const input = page.getByTestId('rename-project-input');
    await input.clear();
    await input.fill('<svg onload="alert(1)">');
    await page.getByTestId('rename-project-confirm').click();
    await page.waitForTimeout(500);

    let alertFired = false;
    page.on('dialog', () => {
      alertFired = true;
    });
    await page.waitForTimeout(1000);
    expect(alertFired).toBeFalsy();
  });

  test('L.8 HTML injection in command palette search', async ({ authedPage: page }) => {
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(500);

    await page.getByTestId('command-palette-search').fill('<b onmouseover="alert(1)">test</b>');
    await page.waitForTimeout(500);

    let alertFired = false;
    page.on('dialog', () => {
      alertFired = true;
    });
    await page.waitForTimeout(500);
    expect(alertFired).toBeFalsy();

    // Check that HTML is not rendered
    const hasRawHtml = await page.evaluate(() => {
      const b = document.querySelector('[cmdk-input] ~ * b[onmouseover]');
      return b !== null;
    });
    expect(hasRawHtml).toBeFalsy();

    await page.keyboard.press('Escape');
  });

  test('L.9 XSS via prompt textarea', async ({ authedPage: page, api }) => {
    const thread = await api.createIdleThread(projectId, 'XSS Prompt Thread');

    await page.goto(`/projects/${projectId}/threads/${thread.id}`);
    await page.waitForLoadState('networkidle');

    const textarea = page.getByTestId('prompt-textarea');
    await textarea.fill('```html\n<script>document.title="hacked"</script>\n```');
    await page.waitForTimeout(500);

    // Title should not change
    const title = await page.title();
    expect(title).not.toBe('hacked');

    await api.deleteThread(thread.id);
  });
});
