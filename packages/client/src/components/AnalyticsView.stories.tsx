import type { Meta, StoryObj } from '@storybook/react-vite';
import { okAsync } from 'neverthrow';
import { MemoryRouter } from 'react-router-dom';

import '@/i18n/config';
import { withProjects } from '@/data/projects/testing';
import { api } from '@/lib/api';
import { useAppStore } from '@/stores/app-store';

import { AnalyticsView } from './AnalyticsView';

// ── Mock data ────────────────────────────────────────────────────────────────

const MOCK_OVERVIEW = {
  currentStageDistribution: {
    backlog: 12,
    planning: 8,
    in_progress: 15,
    review: 6,
    done: 22,
    archived: 4,
  },
  createdCount: 67,
  completedCount: 22,
  movedToPlanningCount: 8,
  movedToReviewCount: 6,
  movedToDoneCount: 22,
  movedToArchivedCount: 4,
  totalCost: 14.3725,
  timeRange: { start: '2026-02-14', end: '2026-03-14' },
};

function makeDateRange(days: number) {
  const points: Array<{ date: string; count: number }> = [];
  const now = new Date();
  for (let i = days; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    points.push({ date: d.toISOString().slice(0, 10), count: Math.floor(Math.random() * 8) + 1 });
  }
  return points;
}

const MOCK_TIMELINE = {
  createdByDate: makeDateRange(28),
  completedByDate: makeDateRange(28),
  movedToPlanningByDate: makeDateRange(28),
  movedToReviewByDate: makeDateRange(28),
  movedToDoneByDate: makeDateRange(28),
  movedToArchivedByDate: makeDateRange(28),
  timeRange: { start: '2026-02-14', end: '2026-03-14' },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function seedStores() {
  useAppStore.setState(
    withProjects({
      projects: [
        {
          id: 'proj-1',
          name: 'funny',
          path: '/home/user/projects/funny',
          userId: 'user-1',
          sortOrder: 0,
          createdAt: new Date().toISOString(),
        },
        {
          id: 'proj-2',
          name: 'acme-api',
          path: '/home/user/projects/acme-api',
          userId: 'user-1',
          sortOrder: 1,
          createdAt: new Date().toISOString(),
        },
      ],
      selectedProjectId: 'proj-1',
    }),
  );
}

function mockApi(overviewData: any, timelineData: any) {
  api.analyticsOverview = () => okAsync(overviewData);
  api.analyticsTimeline = () => okAsync(timelineData);
}

// ── Meta ─────────────────────────────────────────────────────────────────────

const meta = {
  title: 'Analytics/AnalyticsView',
  component: AnalyticsView,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <MemoryRouter>
        <div className="flex h-screen w-full">
          <Story />
        </div>
      </MemoryRouter>
    ),
  ],
} satisfies Meta<typeof AnalyticsView>;

export default meta;
type Story = StoryObj<typeof meta>;

// ── Stories ──────────────────────────────────────────────────────────────────

/** Full analytics dashboard with metrics, pie chart, and timeline. */
export const Default: Story = {
  render: () => {
    seedStores();
    mockApi(MOCK_OVERVIEW, MOCK_TIMELINE);
    return <AnalyticsView />;
  },
};

/** Loading state while data is being fetched. */
export const Loading: Story = {
  render: () => {
    seedStores();
    // Return promises that never resolve to keep loading state
    api.analyticsOverview = () => new Promise(() => {}) as any;
    api.analyticsTimeline = () => new Promise(() => {}) as any;
    return <AnalyticsView />;
  },
};

/** Empty state when API returns no data. */
export const NoData: Story = {
  render: () => {
    seedStores();
    mockApi(
      {
        currentStageDistribution: {},
        createdCount: 0,
        completedCount: 0,
        movedToPlanningCount: 0,
        movedToReviewCount: 0,
        movedToDoneCount: 0,
        movedToArchivedCount: 0,
        totalCost: 0,
        timeRange: { start: '2026-02-14', end: '2026-03-14' },
      },
      {
        createdByDate: [],
        completedByDate: [],
        movedToPlanningByDate: [],
        movedToReviewByDate: [],
        movedToDoneByDate: [],
        movedToArchivedByDate: [],
        timeRange: { start: '2026-02-14', end: '2026-03-14' },
      },
    );
    return <AnalyticsView />;
  },
};

/** Dashboard without cost data (totalCost = 0 hides the cost card). */
export const NoCost: Story = {
  render: () => {
    seedStores();
    mockApi({ ...MOCK_OVERVIEW, totalCost: 0 }, MOCK_TIMELINE);
    return <AnalyticsView />;
  },
};

/** Dashboard with only a few stages populated. */
export const PartialDistribution: Story = {
  render: () => {
    seedStores();
    mockApi(
      {
        ...MOCK_OVERVIEW,
        currentStageDistribution: {
          in_progress: 10,
          done: 5,
        },
      },
      MOCK_TIMELINE,
    );
    return <AnalyticsView />;
  },
};
