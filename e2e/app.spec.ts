import { test, expect, waitForSidebar } from './fixtures';

test('app loads and shows sidebar', async ({ authedPage: page }) => {
  await waitForSidebar(page);
  await expect(page.getByTestId('sidebar-settings')).toBeVisible();
  await expect(page.getByTestId('sidebar-add-project')).toBeVisible();
});
