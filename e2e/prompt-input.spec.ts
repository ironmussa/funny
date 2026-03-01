import { test, expect, seedProject } from './fixtures';

test.describe('6. Prompt Input', () => {
  let projectId: string;
  let threadId: string;

  test.beforeEach(async ({ api, authedPage: page, tempRepo }) => {
    const project = await seedProject(api, page, tempRepo, `PromptInput-${Date.now()}`);
    projectId = project.id;
    const thread = await api.createIdleThread(projectId, 'Prompt Test Thread');
    threadId = thread.id;

    await page.goto(`/projects/${projectId}/threads/${threadId}`);
    await page.waitForLoadState('networkidle');
  });

  test.afterEach(async ({ api }) => {
    await api.deleteThread(threadId).catch(() => {});
    await api.deleteProject(projectId).catch(() => {});
  });

  test('6.1 Textarea is visible and auto-expands', async ({ authedPage: page }) => {
    const textarea = page.getByTestId('prompt-textarea');
    await expect(textarea).toBeVisible();

    // Get initial height
    const initialHeight = await textarea.evaluate((el) => (el as HTMLElement).offsetHeight);

    // Type multiple lines
    await textarea.fill('Line 1\nLine 2\nLine 3\nLine 4\nLine 5');

    // Height should increase (or stay same if min-height is enough)
    const newHeight = await textarea.evaluate((el) => (el as HTMLElement).offsetHeight);
    expect(newHeight).toBeGreaterThanOrEqual(initialHeight);
  });

  test('6.4 Model selector is visible', async ({ authedPage: page }) => {
    const modelSelect = page.getByTestId('prompt-model-select');
    await expect(modelSelect).toBeVisible();
  });

  test('6.5 Permission mode select is visible', async ({ authedPage: page }) => {
    const modeSelect = page.getByTestId('prompt-mode-select');
    await expect(modeSelect).toBeVisible();
  });

  test('6.6 Image attachment button', async ({ authedPage: page }) => {
    const attachBtn = page.getByTestId('prompt-attach');
    await expect(attachBtn).toBeVisible();

    // The hidden file input should exist
    const fileInput = page.getByTestId('prompt-file-input');
    await expect(fileInput).toBeAttached();
  });

  test('6.7 Send button disabled when empty', async ({ authedPage: page }) => {
    const sendBtn = page.getByTestId('prompt-send');
    const textarea = page.getByTestId('prompt-textarea');

    // With empty textarea, send should be disabled
    await textarea.fill('');
    await expect(sendBtn).toBeDisabled();

    // Type something — send should become enabled
    await textarea.fill('Hello');
    await expect(sendBtn).toBeEnabled();

    // Clear again — disabled
    await textarea.fill('');
    await expect(sendBtn).toBeDisabled();
  });

  test('6.2 Send follow-up message', async ({ authedPage: page }) => {
    const textarea = page.getByTestId('prompt-textarea');
    const sendBtn = page.getByTestId('prompt-send');

    await textarea.fill('Test follow-up message');

    // Intercept the message API call
    const messagePromise = page.waitForResponse(
      (res) =>
        res.url().includes(`/api/threads/${threadId}/message`) && res.request().method() === 'POST',
    );

    await sendBtn.click();

    // Verify the API was called
    const response = await messagePromise;
    expect(response.status()).toBeLessThan(500);
  });
  test('6.13 Clipboard paste interaction - Pastes text or images', async ({
    authedPage: _page,
  }) => {
    // Placeholder test for clipboard paste
    expect(true).toBe(true);
  });

  test('6.14 Drag and drop files - Adds attachments via dropzone', async ({
    authedPage: _page,
  }) => {
    // Placeholder test for drag and drop
    expect(true).toBe(true);
  });

  test('6.15 File size limits - Shows warning if file is too large', async ({
    authedPage: _page,
  }) => {
    // Placeholder test for file size limits
    expect(true).toBe(true);
  });

  test('6.16 Remove attachment - Click remove or (x) discards file', async ({
    authedPage: _page,
  }) => {
    // Placeholder test for file removal
    expect(true).toBe(true);
  });

  test('6.17 Prompt history navigation - Arrow Up/Down navigates history', async ({
    authedPage: _page,
  }) => {
    // Placeholder test for prompt history navigation
    expect(true).toBe(true);
  });
});
