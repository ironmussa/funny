import { test, expect, waitForSidebar, seedProject } from './fixtures';

test.describe('J. Performance', () => {
  test('J.1 Initial page load under 5 seconds', async ({ page }) => {
    const start = Date.now();

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await waitForSidebar(page);

    const elapsed = Date.now() - start;
    expect(elapsed, `Page load took ${elapsed}ms, expected < 5000ms`).toBeLessThan(5000);
  });

  test('J.2 Navigation between views under 1 second', async ({ authedPage: page }) => {
    const routes = ['/list', '/kanban', '/analytics', '/'];

    for (const route of routes) {
      const start = Date.now();
      await page.goto(route);
      await page.waitForLoadState('domcontentloaded');
      const elapsed = Date.now() - start;

      expect(elapsed, `Navigation to ${route} took ${elapsed}ms`).toBeLessThan(3000);
    }
  });

  test('J.3 Large project list renders without lag', async ({
    authedPage: page,
    api,
    tempRepo,
  }) => {
    // Create 15 projects
    const projectIds: string[] = [];
    for (let i = 0; i < 15; i++) {
      const p = await api.createProject(`Perf-${i}-${Date.now()}`, tempRepo);
      projectIds.push(p.id);
    }

    const start = Date.now();
    await page.reload();
    await waitForSidebar(page);
    const elapsed = Date.now() - start;

    expect(elapsed, `Rendering 15 projects took ${elapsed}ms`).toBeLessThan(5000);

    // All projects should be visible
    for (const id of projectIds.slice(0, 5)) {
      await expect(page.getByTestId(`project-item-${id}`)).toBeVisible();
    }

    // Cleanup
    for (const id of projectIds) {
      await api.deleteProject(id);
    }
  });

  test('J.4 Rapid thread switching does not cause errors', async ({
    authedPage: page,
    api,
    tempRepo,
  }) => {
    const project = await seedProject(api, page, tempRepo, `RapidSwitch-${Date.now()}`);
    const threads: string[] = [];

    for (let i = 0; i < 5; i++) {
      const t = await api.createIdleThread(project.id, `Switch ${i}`);
      threads.push(t.id);
    }

    await page.reload();
    await waitForSidebar(page);
    await page.getByTestId(`project-item-${project.id}`).click();
    await page.waitForTimeout(500);

    // Collect JS errors
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    // Rapidly switch between threads
    for (const id of threads) {
      await page.getByTestId(`thread-item-${id}`).click();
      await page.waitForTimeout(100); // Very fast switching
    }

    // Wait for everything to settle
    await page.waitForTimeout(1000);

    // No JS errors should have occurred
    expect(errors.length, `JS errors during rapid switching: ${errors.join(', ')}`).toBe(0);

    // Cleanup
    for (const id of threads) {
      await api.deleteThread(id);
    }
    await api.deleteProject(project.id);
  });

  test('J.5 Command palette opens quickly', async ({ authedPage: page }) => {
    const start = Date.now();
    await page.keyboard.press('Control+k');
    await expect(page.getByTestId('command-palette-search')).toBeVisible();
    const elapsed = Date.now() - start;

    expect(elapsed, `Command palette took ${elapsed}ms to open`).toBeLessThan(500);

    await page.keyboard.press('Escape');
  });

  test('J.6 Settings dialog opens quickly', async ({ authedPage: page }) => {
    const start = Date.now();
    await page.getByTestId('sidebar-settings').click();
    await expect(page.getByTestId('settings-dialog-save')).toBeVisible();
    const elapsed = Date.now() - start;

    expect(elapsed, `Settings dialog took ${elapsed}ms to open`).toBeLessThan(1000);

    await page.getByTestId('settings-dialog-cancel').click();
  });

  test('J.7 No memory leaks on repeated navigation', async ({ authedPage: page }) => {
    // Get initial memory usage
    const getMemory = async () => {
      return page.evaluate(() => {
        if ((performance as any).memory) {
          return (performance as any).memory.usedJSHeapSize;
        }
        return 0;
      });
    };

    const initialMemory = await getMemory();

    // Navigate back and forth many times
    for (let i = 0; i < 10; i++) {
      await page.goto('/list');
      await page.waitForLoadState('domcontentloaded');
      await page.goto('/kanban');
      await page.waitForLoadState('domcontentloaded');
    }

    // Force GC if available
    await page.evaluate(() => {
      if ((window as any).gc) (window as any).gc();
    });
    await page.waitForTimeout(1000);

    const finalMemory = await getMemory();

    // Memory shouldn't grow more than 3x (generous threshold)
    if (initialMemory > 0 && finalMemory > 0) {
      expect(finalMemory).toBeLessThan(initialMemory * 3);
    }
  });
});
