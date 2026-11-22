import { test, expect, seedProject } from './fixtures';

// openspec settings-filter: the filter input above the Preferences and
// Project Settings sidebars finds settings inside pages and jumps to them.

test.describe('Settings filter', () => {
  let projectId: string;

  test.beforeEach(async ({ api, authedPage: page, tempRepo }) => {
    const project = await seedProject(api, page, tempRepo, `SettingsFilter-${Date.now()}`);
    projectId = project.id;
  });

  test.afterEach(async ({ api }) => {
    await api.deleteProject(projectId).catch(() => {});
  });

  test('finds a setting inside a page and highlights it', async ({ authedPage: page }) => {
    await page.goto('/preferences/general');
    await page.waitForLoadState('networkidle');

    await page.getByTestId('settings-filter-input').fill('font');
    await expect(page.getByTestId('preferences-nav-general')).toBeHidden();
    await page.getByTestId('settings-filter-result-appearance.font-size').click();

    await expect(page).toHaveURL(/preferences\/appearance/);
    const row = page.locator('[data-setting-id="appearance.font-size"]');
    await expect(row).toBeInViewport();
    await expect(row).toHaveClass(/setting-focus-highlight/);

    // The filter text survives the navigation; Escape restores the full list.
    const input = page.getByTestId('settings-filter-input');
    await expect(input).toHaveValue('font');
    await input.press('Escape');
    await expect(page.getByTestId('preferences-nav-general')).toBeVisible();
  });

  test('the cross-surface hint opens Preferences from Project Settings', async ({
    authedPage: page,
  }) => {
    await page.goto(`/projects/${projectId}/settings/general`);
    await page.waitForLoadState('networkidle');

    // Font size is a Preferences setting: Project Settings has no match.
    await page.getByTestId('settings-filter-input').fill('font size');
    await expect(page.getByTestId('settings-filter-empty')).toBeVisible();
    await page.getByTestId('settings-filter-cross-hint').click();

    await expect(page).toHaveURL(/preferences\/appearance/);
    await expect(page.getByTestId('settings-filter-input')).toHaveValue('font size');
    await expect(page.locator('[data-setting-id="appearance.font-size"]')).toBeInViewport();
  });

  test('dims the rows of the open page that do not match', async ({ authedPage: page }) => {
    await page.goto(`/projects/${projectId}/settings/general`);
    await page.waitForLoadState('networkidle');

    await page.getByTestId('settings-filter-input').fill('default branch');
    await expect(
      page.locator('[data-setting-id="project-general.default-branch"]'),
    ).not.toHaveClass(/opacity-50/);
    await expect(page.locator('[data-setting-id="project-general.fast-mode"]')).toHaveClass(
      /opacity-50/,
    );
  });
});
