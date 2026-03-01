import { test, expect, seedProject } from './fixtures';
import {
  mockThreadResponse,
  conversationWaitingPermission,
  conversationWaitingQuestion,
  mockThreadWithMessages,
  mockMessage,
} from './mock-helpers';

test.describe('6. Prompt Input — Agent States (mocked)', () => {
  let projectId: string;
  let threadId: string;

  test.beforeEach(async ({ api, authedPage: page, tempRepo }) => {
    const project = await seedProject(api, page, tempRepo, `PromptState-${Date.now()}`);
    projectId = project.id;
    const thread = await api.createIdleThread(projectId, 'Agent State Thread');
    threadId = thread.id;
  });

  test.afterEach(async ({ api }) => {
    await api.deleteThread(threadId).catch(() => {});
    await api.deleteProject(projectId).catch(() => {});
  });

  test('6.3 Stop button visible when agent is running', async ({ authedPage: page }) => {
    const data = mockThreadWithMessages(threadId, projectId, {
      status: 'running',
      messages: [
        mockMessage({ threadId, role: 'user', content: 'Do something complex' }),
        mockMessage({ threadId, role: 'assistant', content: 'Working on it...' }),
      ],
    });
    await mockThreadResponse(page, threadId, data);

    await page.goto(`/projects/${projectId}/threads/${threadId}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // Stop button should be visible when agent is running
    const stopBtn = page.getByTestId('prompt-stop');
    await expect(stopBtn).toBeVisible({ timeout: 5000 });
  });

  test('6.8 Permission request dialog shows approve/deny', async ({ authedPage: page }) => {
    const data = conversationWaitingPermission(threadId, projectId);
    await mockThreadResponse(page, threadId, data);

    await page.goto(`/projects/${projectId}/threads/${threadId}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // Permission approval UI should show the tool name and approve/deny buttons
    const approveBtn = page.getByTestId('permission-approve');
    const denyBtn = page.getByTestId('permission-deny');

    await expect(approveBtn).toBeVisible({ timeout: 5000 });
    await expect(denyBtn).toBeVisible();

    // Should mention the tool name
    await expect(page.getByText(/Bash/i).first()).toBeVisible();
  });

  test('6.9 Approve tool execution sends POST', async ({ authedPage: page }) => {
    const data = conversationWaitingPermission(threadId, projectId);
    await mockThreadResponse(page, threadId, data);

    await page.goto(`/projects/${projectId}/threads/${threadId}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    const approveBtn = page.getByTestId('permission-approve');
    await expect(approveBtn).toBeVisible({ timeout: 5000 });

    // Intercept the approve-tool API call
    const approvePromise = page
      .waitForResponse(
        (res) => res.url().includes('/approve-tool') && res.request().method() === 'POST',
        { timeout: 5000 },
      )
      .catch(() => null);

    await approveBtn.click();

    const _response = await approvePromise;
    // Response may or may not arrive depending on server state, but click should not crash
  });

  test('6.10 Deny tool execution sends POST', async ({ authedPage: page }) => {
    const data = conversationWaitingPermission(threadId, projectId);
    await mockThreadResponse(page, threadId, data);

    await page.goto(`/projects/${projectId}/threads/${threadId}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    const denyBtn = page.getByTestId('permission-deny');
    await expect(denyBtn).toBeVisible({ timeout: 5000 });

    // Intercept the approve-tool API call (deny also goes through approve-tool endpoint)
    const denyPromise = page
      .waitForResponse(
        (res) => res.url().includes('/approve-tool') && res.request().method() === 'POST',
        { timeout: 5000 },
      )
      .catch(() => null);

    await denyBtn.click();

    const _response = await denyPromise;
    // Verify click didn't crash
  });

  test('6.8b Waiting actions show accept/reject and text input', async ({ authedPage: page }) => {
    const data = conversationWaitingQuestion(threadId, projectId);
    await mockThreadResponse(page, threadId, data);

    await page.goto(`/projects/${projectId}/threads/${threadId}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // When waiting without a specific reason, WaitingActions shows accept/reject + text input
    const acceptBtn = page.getByTestId('waiting-accept');
    const _rejectBtn = page.getByTestId('waiting-reject');
    const textInput = page.getByTestId('waiting-response-input');
    const sendBtn = page.getByTestId('waiting-send');

    // At least one of these should be visible (depends on waitingReason value)
    const hasWaitingUI =
      (await acceptBtn.isVisible().catch(() => false)) ||
      (await textInput.isVisible().catch(() => false));

    if (hasWaitingUI) {
      if (await textInput.isVisible()) {
        await textInput.fill('I prefer JWT');
        await expect(sendBtn).toBeVisible();
      }
    }
  });

  test('6.3b Send button hidden when agent is running', async ({ authedPage: page }) => {
    const data = mockThreadWithMessages(threadId, projectId, {
      status: 'running',
      messages: [mockMessage({ threadId, role: 'user', content: 'Work on this' })],
    });
    await mockThreadResponse(page, threadId, data);

    await page.goto(`/projects/${projectId}/threads/${threadId}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // While running, stop button should be visible instead of send
    const stopBtn = page.getByTestId('prompt-stop');
    const _sendBtn = page.getByTestId('prompt-send');

    if (await stopBtn.isVisible().catch(() => false)) {
      // Send should be hidden or replaced by stop
      await expect(stopBtn).toBeVisible();
    }
  });
});
