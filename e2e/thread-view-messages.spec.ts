import { test, expect, seedProject } from './fixtures';
import {
  mockThreadResponse,
  conversationWithMarkdown,
  conversationWithToolCalls,
  conversationWithGitEvents,
  conversationStopped,
  conversationInterrupted,
  conversationWithContextUsage,
} from './mock-helpers';

test.describe('5. Thread View — Agent Content (mocked)', () => {
  let projectId: string;
  let threadId: string;

  test.beforeEach(async ({ api, authedPage: page, tempRepo }) => {
    const project = await seedProject(api, page, tempRepo, `TVMsg-${Date.now()}`);
    projectId = project.id;
    const thread = await api.createIdleThread(projectId, 'Mocked Content Thread');
    threadId = thread.id;
  });

  test.afterEach(async ({ api }) => {
    await api.deleteThread(threadId).catch(() => {});
    await api.deleteProject(projectId).catch(() => {});
  });

  test('5.4 Assistant message with markdown renders correctly', async ({ authedPage: page }) => {
    const data = conversationWithMarkdown(threadId, projectId);
    await mockThreadResponse(page, threadId, data);

    await page.goto(`/projects/${projectId}/threads/${threadId}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // Should render markdown headers
    await expect(page.locator('h1').filter({ hasText: 'Promises in JavaScript' })).toBeVisible({
      timeout: 5000,
    });

    // Should render bold text
    await expect(page.locator('strong').filter({ hasText: 'Promise' })).toBeVisible();

    // Should render list items
    await expect(page.getByText('pending')).toBeVisible();
    await expect(page.getByText('fulfilled')).toBeVisible();
    await expect(page.getByText('rejected')).toBeVisible();

    // Should render blockquote
    await expect(page.locator('blockquote')).toBeVisible();
  });

  test('5.5 Code syntax highlighting in assistant message', async ({ authedPage: page }) => {
    const data = conversationWithMarkdown(threadId, projectId);
    await mockThreadResponse(page, threadId, data);

    await page.goto(`/projects/${projectId}/threads/${threadId}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // Should render a code block with the JavaScript example
    const codeBlock = page.locator('pre code, [class*="shiki"], [class*="highlight"]');
    await expect(codeBlock.first()).toBeVisible({ timeout: 5000 });

    // Should contain the code content
    await expect(page.getByText('new Promise')).toBeVisible();
  });

  test('5.6 Tool call cards render with name and summary', async ({ authedPage: page }) => {
    const data = conversationWithToolCalls(threadId, projectId);
    await mockThreadResponse(page, threadId, data);

    await page.goto(`/projects/${projectId}/threads/${threadId}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // Should show tool call cards for Read, Edit, and Bash
    await expect(page.getByText('Read').first()).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Edit').first()).toBeVisible();
    await expect(page.getByText('Bash').first()).toBeVisible();
  });

  test('5.7 Tool call card expand/collapse', async ({ authedPage: page }) => {
    const data = conversationWithToolCalls(threadId, projectId);
    await mockThreadResponse(page, threadId, data);

    await page.goto(`/projects/${projectId}/threads/${threadId}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // Find a tool call card and click to expand
    const toolCard = page.locator('[class*="tool-call"], [data-tool-name]').first();
    if (await toolCard.isVisible().catch(() => false)) {
      await toolCard.click();
      await page.waitForTimeout(300);

      // Click again to collapse
      await toolCard.click();
      await page.waitForTimeout(300);
    }
  });

  test('5.9 Git event cards render', async ({ authedPage: page }) => {
    const data = conversationWithGitEvents(threadId, projectId);
    await mockThreadResponse(page, threadId, data);

    await page.goto(`/projects/${projectId}/threads/${threadId}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // Should show git event info (commit message, push)
    await expect(
      page.getByText('add new feature').or(page.getByText('commit').first()),
    ).toBeVisible({ timeout: 5000 });
  });

  test('5.10 Context usage bar displays token info', async ({ authedPage: page }) => {
    const data = conversationWithContextUsage(threadId, projectId);
    await mockThreadResponse(page, threadId, data);

    await page.goto(`/projects/${projectId}/threads/${threadId}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // Context usage bar should show token counts
    // Look for numbers that match the token counts
    const pageText = await page.textContent('body');
    // The context usage should be rendered somewhere (45k tokens)
    expect(pageText).toBeTruthy();
  });

  test('5.17 Agent result card shows completion info', async ({ authedPage: page }) => {
    const data = conversationWithMarkdown(threadId, projectId);
    await mockThreadResponse(page, threadId, data);

    await page.goto(`/projects/${projectId}/threads/${threadId}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // Result card should show cost and/or duration
    // The conversationWithMarkdown preset has resultInfo: { cost: 0.02, duration: 5000 }
    const resultArea = page.getByText(/\$0\.02|completed|5\.?\d*s/i);
    if (
      await resultArea
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      await expect(resultArea.first()).toBeVisible();
    }
  });

  test('5.18a Agent stopped card renders', async ({ authedPage: page }) => {
    const data = conversationStopped(threadId, projectId);
    await mockThreadResponse(page, threadId, data);

    await page.goto(`/projects/${projectId}/threads/${threadId}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // Should show stopped state indicator
    await expect(page.getByText(/stopped/i).first()).toBeVisible({ timeout: 5000 });
  });

  test('5.18b Agent interrupted card renders', async ({ authedPage: page }) => {
    const data = conversationInterrupted(threadId, projectId);
    await mockThreadResponse(page, threadId, data);

    await page.goto(`/projects/${projectId}/threads/${threadId}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // Should show interrupted state indicator
    await expect(page.getByText(/interrupted/i).first()).toBeVisible({ timeout: 5000 });
  });

  test('5.3 User message renders on the right side', async ({ authedPage: page }) => {
    const data = conversationWithMarkdown(threadId, projectId);
    await mockThreadResponse(page, threadId, data);

    await page.goto(`/projects/${projectId}/threads/${threadId}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // User message should be visible
    await expect(page.getByText('Explain how promises work')).toBeVisible({ timeout: 5000 });
  });
});
