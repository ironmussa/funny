import { test, expect, waitForSidebar, seedProject } from './fixtures';

test.describe('F. Dark Mode', () => {
  // Reset to system theme after each test
  test.afterEach(async ({ page }) => {
    try {
      await page.getByTestId('sidebar-settings').click();
      await page.waitForTimeout(300);
      await page.getByTestId('settings-dialog-theme-system').click();
      await page.getByTestId('settings-dialog-save').click();
    } catch {
      // Ignore cleanup errors
    }
  });

  test('F.1 Theme persists on reload', async ({ authedPage: page }) => {
    await waitForSidebar(page);

    // Switch to dark
    await page.getByTestId('sidebar-settings').click();
    await page.getByTestId('settings-dialog-theme-dark').click();
    await page.getByTestId('settings-dialog-save').click();
    await page.waitForTimeout(500);

    // Verify dark class is applied
    const hasDarkClass = await page.evaluate(() => {
      return document.documentElement.classList.contains('dark');
    });
    expect(hasDarkClass).toBeTruthy();

    // Reload page
    await page.reload();
    await waitForSidebar(page);

    // Dark theme should persist
    const stillDark = await page.evaluate(() => {
      return document.documentElement.classList.contains('dark');
    });
    expect(stillDark).toBeTruthy();
  });

  test('F.2 Dark mode applies to all views', async ({ authedPage: page, api, tempRepo }) => {
    // Switch to dark
    await page.getByTestId('sidebar-settings').click();
    await page.getByTestId('settings-dialog-theme-dark').click();
    await page.getByTestId('settings-dialog-save').click();
    await page.waitForTimeout(500);

    const project = await seedProject(api, page, tempRepo, `DarkMode-${Date.now()}`);

    // Check dark class on different views
    const views = ['/list', '/kanban', '/analytics', `/projects/${project.id}/settings/general`];

    for (const viewPath of views) {
      await page.goto(viewPath);
      await page.waitForLoadState('networkidle');

      const hasDark = await page.evaluate(() => {
        return document.documentElement.classList.contains('dark');
      });
      expect(hasDark, `Dark mode should be active on ${viewPath}`).toBeTruthy();
    }

    await api.deleteProject(project.id);
  });

  test('F.3 Light mode works correctly', async ({ authedPage: page }) => {
    await waitForSidebar(page);

    // Switch to light
    await page.getByTestId('sidebar-settings').click();
    await page.getByTestId('settings-dialog-theme-light').click();
    await page.getByTestId('settings-dialog-save').click();
    await page.waitForTimeout(500);

    // Verify light (no dark class)
    const hasDarkClass = await page.evaluate(() => {
      return document.documentElement.classList.contains('dark');
    });
    expect(hasDarkClass).toBeFalsy();
  });

  test('F.4 No invisible text in dark mode', async ({ authedPage: page }) => {
    // Switch to dark
    await page.getByTestId('sidebar-settings').click();
    await page.getByTestId('settings-dialog-theme-dark').click();
    await page.getByTestId('settings-dialog-save').click();
    await page.waitForTimeout(500);

    // Check that text elements have sufficient contrast
    // This is a basic check — proper a11y testing needs axe-core
    const textElements = await page.evaluate(() => {
      const elements = document.querySelectorAll('button, a, p, span, h1, h2, h3, label');
      const issues: string[] = [];

      for (const el of Array.from(elements).slice(0, 50)) {
        const style = window.getComputedStyle(el);
        const color = style.color;
        const bg = style.backgroundColor;

        // If both text and bg are the same color, that's a problem
        if (color && bg && color === bg && color !== 'rgba(0, 0, 0, 0)') {
          issues.push(
            `${el.tagName}: text="${el.textContent?.slice(0, 20)}" color=${color} bg=${bg}`,
          );
        }
      }
      return issues;
    });

    expect(textElements.length, `Found invisible text: ${textElements.join(', ')}`).toBe(0);
  });

  test('F.5 Theme toggle cycles correctly', async ({ authedPage: page }) => {
    await waitForSidebar(page);

    // Light → Dark → System → Light
    const themes = ['light', 'dark', 'system'] as const;

    for (const theme of themes) {
      await page.getByTestId('sidebar-settings').click();
      await page.waitForTimeout(300);
      await page.getByTestId(`settings-dialog-theme-${theme}`).click();
      await page.getByTestId('settings-dialog-save').click();
      await page.waitForTimeout(300);
    }

    // App should still be functional
    await expect(page.getByTestId('sidebar-settings')).toBeVisible();
  });

  test('F.6 System theme respects OS preference', async ({ authedPage: page }) => {
    // Set to system theme
    await page.getByTestId('sidebar-settings').click();
    await page.getByTestId('settings-dialog-theme-system').click();
    await page.getByTestId('settings-dialog-save').click();
    await page.waitForTimeout(500);

    // Emulate dark color scheme
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(500);

    const isDark = await page.evaluate(() => {
      return document.documentElement.classList.contains('dark');
    });
    expect(isDark).toBeTruthy();

    // Emulate light color scheme
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForTimeout(500);

    const isLight = await page.evaluate(() => {
      return !document.documentElement.classList.contains('dark');
    });
    expect(isLight).toBeTruthy();
  });
});
