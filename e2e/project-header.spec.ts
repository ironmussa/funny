import { test, expect, seedProject } from './fixtures';

test.describe('13. Project Header Actions', () => {
  let projectId: string;
  let threadId: string;

  test.beforeEach(async ({ api, authedPage: page, tempRepo }) => {
    const project = await seedProject(api, page, tempRepo, `ProjHeader-${Date.now()}`);
    projectId = project.id;
    const thread = await api.createIdleThread(projectId, 'Header Test Thread');
    threadId = thread.id;

    await page.goto(`/projects/${projectId}/threads/${threadId}`);
    await page.waitForLoadState('networkidle');
  });

  test.afterEach(async ({ api }) => {
    await api.deleteThread(threadId).catch(() => {});
    await api.deleteProject(projectId).catch(() => {});
  });

  test('13.1 More actions menu opens', async ({ authedPage: page }) => {
    const moreActions = page.getByTestId('header-more-actions');
    await expect(moreActions).toBeVisible();

    await moreActions.click();
    await page.waitForTimeout(300);

    // Menu items should appear
    await expect(page.getByTestId('header-menu-copy-text')).toBeVisible();
    await expect(page.getByTestId('header-menu-copy-all')).toBeVisible();
  });

  test('13.2 Copy text menu item', async ({ authedPage: page }) => {
    await page.getByTestId('header-more-actions').click();
    await page.waitForTimeout(300);

    await page.getByTestId('header-menu-copy-text').click();
    // Menu should close after clicking
    await page.waitForTimeout(300);
  });

  test('13.3 Copy all menu item', async ({ authedPage: page }) => {
    await page.getByTestId('header-more-actions').click();
    await page.waitForTimeout(300);

    await page.getByTestId('header-menu-copy-all').click();
    await page.waitForTimeout(300);
  });

  test('13.4 Pin thread via header menu', async ({ authedPage: page }) => {
    await page.getByTestId('header-more-actions').click();
    await page.waitForTimeout(300);

    const pinBtn = page.getByTestId('header-menu-pin');
    if (await pinBtn.isVisible()) {
      await pinBtn.click();
      await page.waitForTimeout(300);
    }
  });

  test('13.5 Delete thread via header menu', async ({ authedPage: page }) => {
    await page.getByTestId('header-more-actions').click();
    await page.waitForTimeout(300);

    const deleteBtn = page.getByTestId('header-menu-delete');
    if (await deleteBtn.isVisible()) {
      await deleteBtn.click();
      await page.waitForTimeout(300);

      // Confirm dialog
      await expect(page.getByTestId('header-delete-confirm')).toBeVisible();
      await expect(page.getByTestId('header-delete-cancel')).toBeVisible();

      // Cancel
      await page.getByTestId('header-delete-cancel').click();
      await expect(page.getByTestId('header-delete-confirm')).not.toBeVisible();
    }
  });

  test('13.5b Delete thread confirm', async ({ authedPage: page }) => {
    await page.getByTestId('header-more-actions').click();
    await page.waitForTimeout(300);

    const deleteBtn = page.getByTestId('header-menu-delete');
    if (await deleteBtn.isVisible()) {
      await deleteBtn.click();
      await page.waitForTimeout(300);

      await page.getByTestId('header-delete-confirm').click();

      // Should navigate away from the deleted thread
      await page.waitForTimeout(500);
      await expect(page).not.toHaveURL(new RegExp(`/threads/${threadId}`));
    }
  });

  test('13.6 Stage selector', async ({ authedPage: page }) => {
    const stageSelect = page.getByTestId('header-stage-select');
    if (await stageSelect.isVisible()) {
      await stageSelect.click();
      await page.waitForTimeout(300);
    }
  });

  test('13.13 Toggle review pane from header', async ({ authedPage: page }) => {
    const toggleReview = page.getByTestId('header-toggle-review');
    await expect(toggleReview).toBeVisible();

    // Open
    await toggleReview.click();
    await page.waitForTimeout(500);
    await expect(page.getByTestId('review-close')).toBeVisible();

    // Close
    await toggleReview.click();
    await page.waitForTimeout(500);
    await expect(page.getByTestId('review-close')).not.toBeVisible();
  });

  test('13.10 Preview button', async ({ authedPage: page }) => {
    const previewBtn = page.getByTestId('header-preview');
    if (await previewBtn.isVisible()) {
      await previewBtn.click();
      await page.waitForTimeout(500);
    }
  });

  test('13.11 Open in editor button', async ({ authedPage: page }) => {
    const editorBtn = page.getByTestId('header-open-editor');
    if (await editorBtn.isVisible()) {
      await editorBtn.click();
      await page.waitForTimeout(300);
    }
  });
});

test.describe('13. Project Header - Project-level (no thread)', () => {
  let projectId: string;

  test.beforeEach(async ({ api, authedPage: page, tempRepo }) => {
    const project = await seedProject(api, page, tempRepo, `ProjHeaderNoThread-${Date.now()}`);
    projectId = project.id;

    await page.goto(`/projects/${projectId}`);
    await page.waitForLoadState('networkidle');
  });

  test.afterEach(async ({ api }) => {
    await api.deleteProject(projectId).catch(() => {});
  });

  test('13.9 View board button', async ({ authedPage: page }) => {
    const boardBtn = page.getByTestId('header-view-board');
    if (await boardBtn.isVisible()) {
      await boardBtn.click();
      await page.waitForTimeout(500);
    }
  });

  test('13.14 Startup commands button', async ({ authedPage: page }) => {
    const cmdBtn = page.getByTestId('header-startup-commands');
    if (await cmdBtn.isVisible()) {
      await cmdBtn.click();
      await page.waitForTimeout(300);
    }
  });
});
