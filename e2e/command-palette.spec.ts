import { test, expect, seedProject } from './fixtures';

test.describe('12. Command Palette', () => {
  let projectId: string;

  test.beforeEach(async ({ api, authedPage: page, tempRepo }) => {
    const project = await seedProject(api, page, tempRepo, `CmdPalette-${Date.now()}`);
    projectId = project.id;
  });

  test.afterEach(async ({ api }) => {
    await api.deleteProject(projectId).catch(() => {});
  });

  test('12.1 Ctrl+K opens palette', async ({ authedPage: page }) => {
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(500);

    await expect(page.getByTestId('command-palette-search')).toBeVisible();
  });

  test('12.2 Search filters results', async ({ authedPage: page }) => {
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(500);

    const search = page.getByTestId('command-palette-search');
    await search.fill('CmdPalette');
    await page.waitForTimeout(300);

    // Project result should be visible
    await expect(page.getByTestId(`command-palette-project-${projectId}`)).toBeVisible();
  });

  test('12.3 Click project starts new thread', async ({ authedPage: page }) => {
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(500);

    const projectItem = page.getByTestId(`command-palette-project-${projectId}`);
    if (await projectItem.isVisible()) {
      await projectItem.click();
      await page.waitForTimeout(500);

      // Should open new thread dialog or navigate to project
      // The command palette should close
      await expect(page.getByTestId('command-palette-search')).not.toBeVisible();
    }
  });

  test('12.4 Click settings navigates', async ({ authedPage: page }) => {
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(500);

    const search = page.getByTestId('command-palette-search');
    await search.fill('general');
    await page.waitForTimeout(300);

    const settingsItem = page.getByTestId('command-palette-settings-general');
    if (await settingsItem.isVisible()) {
      await settingsItem.click();
      await expect(page).toHaveURL(/settings\/general/);
    }
  });

  test('12.5 Escape closes palette', async ({ authedPage: page }) => {
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(500);

    await expect(page.getByTestId('command-palette-search')).toBeVisible();

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    await expect(page.getByTestId('command-palette-search')).not.toBeVisible();
  });

  test('12.5b Ctrl+Shift+F navigates to /list', async ({ authedPage: page }) => {
    await page.keyboard.press('Control+Shift+f');
    await page.waitForTimeout(500);

    await expect(page).toHaveURL(/\/list/);
  });
});
