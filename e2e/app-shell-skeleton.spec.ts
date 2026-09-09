import { expect, test } from '@playwright/test';

test('loading shell uses one column on mobile and restores the desktop sidebar', async ({
  page,
}) => {
  // Keep initialization pending so the real loading shell remains on screen.
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    () => {},
  );
  await page.addInitScript(() => localStorage.setItem('sidebar_width', '320'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  const shell = page.getByTestId('app-shell-skeleton');
  const sidebar = page.getByTestId('app-shell-skeleton-sidebar');
  const content = page.getByTestId('app-shell-skeleton-content');
  await expect(shell).toBeVisible();

  for (const width of [320, 390, 767]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(sidebar).toBeHidden();
    await expect(content).toHaveCSS('width', `${width}px`);
    await expect(shell).toHaveCSS('height', '844px');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  }

  for (const width of [768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(sidebar).toBeVisible();
    await expect(sidebar).toHaveCSS('width', '320px');
    await expect(content).toHaveCSS('width', `${width - 320}px`);
  }
});
