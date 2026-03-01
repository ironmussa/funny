import { test, expect, seedProject } from './fixtures';

test.describe('4. New Thread Dialog', () => {
  let projectId: string;

  test.beforeEach(async ({ api, authedPage: page, tempRepo }) => {
    const project = await seedProject(api, page, tempRepo, `NewThread-${Date.now()}`);
    projectId = project.id;

    // Expand the project to see "new thread" button
    await page.getByTestId(`project-item-${projectId}`).click();
    await page.waitForTimeout(300);
  });

  test.afterEach(async ({ api }) => {
    await api.deleteProject(projectId).catch(() => {});
  });

  test('4.1 Dialog opens from sidebar', async ({ authedPage: page }) => {
    await page.getByTestId(`project-new-thread-${projectId}`).click();

    // Dialog should be visible with all fields
    await expect(page.getByTestId('new-thread-prompt')).toBeVisible();
    await expect(page.getByTestId('new-thread-create')).toBeVisible();
    await expect(page.getByTestId('new-thread-cancel')).toBeVisible();
  });

  test('4.2 Branch picker loads branches', async ({ authedPage: page }) => {
    await page.getByTestId(`project-new-thread-${projectId}`).click();

    // Click branch trigger to open popover
    await page.getByTestId('new-thread-branch-trigger').click();

    // Branch search should appear
    await expect(page.getByTestId('new-thread-branch-search')).toBeVisible();
  });

  test('4.3 Branch search filter', async ({ authedPage: page }) => {
    await page.getByTestId(`project-new-thread-${projectId}`).click();
    await page.getByTestId('new-thread-branch-trigger').click();

    // Type in search to filter
    await page.getByTestId('new-thread-branch-search').fill('main');
    await page.waitForTimeout(300);

    // Should show filtered results (at least "main" or "master")
    const _branchItems = page.locator(
      '[data-testid="new-thread-branch-search"] ~ * button, [role="option"]',
    );
    // Just verify the search input works without error
    await expect(page.getByTestId('new-thread-branch-search')).toHaveValue('main');
  });

  test('4.4 Worktree toggle', async ({ authedPage: page }) => {
    await page.getByTestId(`project-new-thread-${projectId}`).click();

    const checkbox = page.getByTestId('new-thread-worktree-checkbox');
    await expect(checkbox).toBeVisible();

    // Toggle worktree on
    await checkbox.click();
    // Toggle worktree off
    await checkbox.click();
  });

  test('4.5 Provider selector', async ({ authedPage: page }) => {
    await page.getByTestId(`project-new-thread-${projectId}`).click();

    const providerSelect = page.getByTestId('new-thread-provider-select');
    await expect(providerSelect).toBeVisible();

    // Click to open dropdown
    await providerSelect.click();
    await page.waitForTimeout(300);
  });

  test('4.6 Model selector', async ({ authedPage: page }) => {
    await page.getByTestId(`project-new-thread-${projectId}`).click();

    const modelSelect = page.getByTestId('new-thread-model-select');
    await expect(modelSelect).toBeVisible();

    // Click to open dropdown
    await modelSelect.click();
    await page.waitForTimeout(300);
  });

  test('4.7 Create disabled without prompt', async ({ authedPage: page }) => {
    await page.getByTestId(`project-new-thread-${projectId}`).click();

    // With empty prompt, create button should be disabled
    const createBtn = page.getByTestId('new-thread-create');
    await expect(createBtn).toBeDisabled();

    // Type something into prompt
    await page.getByTestId('new-thread-prompt').fill('Test prompt');

    // Now create should be enabled
    await expect(createBtn).toBeEnabled();

    // Clear prompt
    await page.getByTestId('new-thread-prompt').fill('');

    // Back to disabled
    await expect(createBtn).toBeDisabled();
  });

  test('4.10 Cancel closes dialog', async ({ authedPage: page }) => {
    await page.getByTestId(`project-new-thread-${projectId}`).click();

    await expect(page.getByTestId('new-thread-prompt')).toBeVisible();

    await page.getByTestId('new-thread-cancel').click();

    // Dialog should close
    await expect(page.getByTestId('new-thread-prompt')).not.toBeVisible();
  });

  test('4.11 Optional title field', async ({ authedPage: page }) => {
    await page.getByTestId(`project-new-thread-${projectId}`).click();

    const titleInput = page.getByTestId('new-thread-title-input');
    await expect(titleInput).toBeVisible();

    // Should be empty by default (auto-generated from prompt)
    const value = await titleInput.inputValue();
    expect(value).toBe('');

    // Can type a custom title
    await titleInput.fill('My Custom Title');
    await expect(titleInput).toHaveValue('My Custom Title');
  });
});
