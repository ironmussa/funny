import { test, expect, waitForSidebar, seedProject } from './fixtures';
import { mockAnalyticsOverview, mockAnalyticsTimeline } from './mock-helpers';

test.describe('16. Analytics View', () => {
  let projectId: string;

  test.beforeEach(async ({ api, authedPage: page, tempRepo }) => {
    const project = await seedProject(api, page, tempRepo, `Analytics-${Date.now()}`);
    projectId = project.id;
  });

  test.afterEach(async ({ api }) => {
    await api.deleteProject(projectId).catch(() => {});
  });

  test('16.1 Analytics view renders with mocked data', async ({ authedPage: page }) => {
    const overview = mockAnalyticsOverview();
    const timeline = mockAnalyticsTimeline();

    // Mock the analytics API endpoints
    await page.route('**/api/analytics/overview**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(overview),
      });
    });
    await page.route('**/api/analytics/timeline**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(timeline),
      });
    });

    await page.goto('/analytics');
    await page.waitForLoadState('networkidle');

    // Metric cards should be visible
    await expect(page.getByTestId('analytics-metric-cards')).toBeVisible();
  });

  test('16.2 Metric cards display correct counts', async ({ authedPage: page }) => {
    const overview = mockAnalyticsOverview({
      createdCount: 42,
      completedCount: 35,
      movedToPlanningCount: 20,
      movedToReviewCount: 15,
      movedToDoneCount: 30,
      movedToArchivedCount: 5,
      totalCost: 2.5,
    });
    const timeline = mockAnalyticsTimeline();

    await page.route('**/api/analytics/overview**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(overview),
      });
    });
    await page.route('**/api/analytics/timeline**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(timeline),
      });
    });

    await page.goto('/analytics');
    await page.waitForLoadState('networkidle');

    // Check that specific counts are displayed
    await expect(page.getByText('42')).toBeVisible();
    await expect(page.getByText('35')).toBeVisible();
  });

  test('16.3 Cost card shows when totalCost > 0', async ({ authedPage: page }) => {
    const overview = mockAnalyticsOverview({ totalCost: 1.2345 });
    const timeline = mockAnalyticsTimeline();

    await page.route('**/api/analytics/overview**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(overview),
      });
    });
    await page.route('**/api/analytics/timeline**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(timeline),
      });
    });

    await page.goto('/analytics');
    await page.waitForLoadState('networkidle');

    // Cost card should be visible
    await expect(page.getByTestId('analytics-cost-card')).toBeVisible();
    // Should show the cost value
    await expect(page.getByText('$1.2345')).toBeVisible();
  });

  test('16.4 Cost card hidden when totalCost is 0', async ({ authedPage: page }) => {
    const overview = mockAnalyticsOverview({ totalCost: 0 });
    const timeline = mockAnalyticsTimeline();

    await page.route('**/api/analytics/overview**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(overview),
      });
    });
    await page.route('**/api/analytics/timeline**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(timeline),
      });
    });

    await page.goto('/analytics');
    await page.waitForLoadState('networkidle');

    // Cost card should not be visible
    await expect(page.getByTestId('analytics-cost-card')).not.toBeVisible();
  });

  test('16.5 Stage distribution chart renders', async ({ authedPage: page }) => {
    const overview = mockAnalyticsOverview({
      currentStageDistribution: {
        backlog: 10,
        planning: 5,
        in_progress: 8,
        review: 3,
        done: 20,
        archived: 2,
      },
    });
    const timeline = mockAnalyticsTimeline();

    await page.route('**/api/analytics/overview**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(overview),
      });
    });
    await page.route('**/api/analytics/timeline**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(timeline),
      });
    });

    await page.goto('/analytics');
    await page.waitForLoadState('networkidle');

    await expect(page.getByTestId('analytics-stage-chart')).toBeVisible();
  });

  test('16.6 Timeline chart renders', async ({ authedPage: page }) => {
    const overview = mockAnalyticsOverview();
    const timeline = mockAnalyticsTimeline();

    await page.route('**/api/analytics/overview**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(overview),
      });
    });
    await page.route('**/api/analytics/timeline**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(timeline),
      });
    });

    await page.goto('/analytics');
    await page.waitForLoadState('networkidle');

    await expect(page.getByTestId('analytics-timeline-chart')).toBeVisible();
  });

  test('16.7 Time range selector changes data', async ({ authedPage: page }) => {
    const overview = mockAnalyticsOverview();
    const timeline = mockAnalyticsTimeline();

    let lastTimeRange = '';
    await page.route('**/api/analytics/overview**', async (route) => {
      const url = new URL(route.request().url());
      lastTimeRange = url.searchParams.get('timeRange') || '';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(overview),
      });
    });
    await page.route('**/api/analytics/timeline**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(timeline),
      });
    });

    await page.goto('/analytics');
    await page.waitForLoadState('networkidle');

    // Click the "Week" time range button
    await page.getByTestId('analytics-time-range-week').click();
    await page.waitForTimeout(500);

    // Verify the request was made with the week time range
    expect(lastTimeRange).toBe('week');
  });

  test('16.8 Group by selector changes timeline grouping', async ({ authedPage: page }) => {
    const overview = mockAnalyticsOverview();
    const timeline = mockAnalyticsTimeline();

    let lastGroupBy = '';
    await page.route('**/api/analytics/overview**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(overview),
      });
    });
    await page.route('**/api/analytics/timeline**', async (route) => {
      const url = new URL(route.request().url());
      lastGroupBy = url.searchParams.get('groupBy') || '';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(timeline),
      });
    });

    await page.goto('/analytics');
    await page.waitForLoadState('networkidle');

    // Click "Week" group by button
    await page.getByTestId('analytics-group-by-week').click();
    await page.waitForTimeout(500);

    expect(lastGroupBy).toBe('week');
  });

  test('16.9 Project filter sends correct projectId', async ({ authedPage: page }) => {
    const overview = mockAnalyticsOverview();
    const timeline = mockAnalyticsTimeline();

    let lastProjectId = '';
    await page.route('**/api/analytics/overview**', async (route) => {
      const url = new URL(route.request().url());
      lastProjectId = url.searchParams.get('projectId') || '__all__';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(overview),
      });
    });
    await page.route('**/api/analytics/timeline**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(timeline),
      });
    });

    await page.goto('/analytics');
    await page.waitForLoadState('networkidle');

    // Open project filter and select the specific project
    await page.getByTestId('analytics-project-filter').click();
    await page.waitForTimeout(300);

    // Look for the project in the dropdown
    const projectOption = page.getByRole('option').filter({ hasText: /Analytics-/ });
    if (await projectOption.isVisible().catch(() => false)) {
      await projectOption.click();
      await page.waitForTimeout(500);
      // Verify the projectId was sent
      expect(lastProjectId).not.toBe('__all__');
    }
  });

  test('16.10 No data message when overview is empty', async ({ authedPage: page }) => {
    // Return null/error for overview
    await page.route('**/api/analytics/overview**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(null),
      });
    });
    await page.route('**/api/analytics/timeline**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(null),
      });
    });

    await page.goto('/analytics');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // No data message should be visible
    await expect(page.getByTestId('analytics-no-data')).toBeVisible();
  });

  test('16.11 Navigate to analytics via sidebar', async ({ authedPage: page }) => {
    await page.goto('/');
    await waitForSidebar(page);

    await page.getByTestId('sidebar-analytics').click();
    await page.waitForLoadState('networkidle');

    // URL should change to /analytics
    expect(page.url()).toContain('/analytics');
  });

  test('16.12 Loading spinner shows while fetching', async ({ authedPage: page }) => {
    // Delay the response
    await page.route('**/api/analytics/overview**', async (route) => {
      await new Promise((r) => setTimeout(r, 2000));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockAnalyticsOverview()),
      });
    });
    await page.route('**/api/analytics/timeline**', async (route) => {
      await new Promise((r) => setTimeout(r, 2000));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockAnalyticsTimeline()),
      });
    });

    await page.goto('/analytics');

    // Loading spinner should appear
    await expect(page.getByTestId('analytics-loading')).toBeVisible();
  });
});
