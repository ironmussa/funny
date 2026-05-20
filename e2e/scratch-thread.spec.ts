import { test, expect } from './fixtures';

test.describe('Scratch threads', () => {
  test('user can create a scratch thread from the sidebar', async ({ authedPage: page }) => {
    // The Scratch section + "+ New" button live in the sidebar between
    // the Threads section and the Projects section. They are user-scoped
    // and don’t require a project.
    const scratchSection = page.getByTestId('sidebar-scratch-section');
    await expect(scratchSection).toBeVisible();

    await page.getByTestId('sidebar-scratch-new').click();

    // The compose form must render in scratch mode — only prompt + model.
    const composeRoot = page.getByTestId('new-thread-scratch');
    await expect(composeRoot).toBeVisible();
    await expect(page.getByTestId('new-thread-scratch-prompt')).toBeVisible();

    // No review pane should be available for scratch threads.
    await expect(page.getByTestId('header-toggle-review')).toHaveCount(0);

    // Branch picker / project context should NOT be rendered.
    await expect(page.getByTestId('new-thread-branch-picker')).toHaveCount(0);
  });
});
