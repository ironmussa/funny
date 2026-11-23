/**
 * Activity tab rows (track-funny-actions, design D9): an action funny took on
 * its own carries the automatic badge, a destructive kind is marked, and a
 * finished row lists its effects.
 */
import { describe, expect, test } from 'bun:test';

import { render, screen } from '@testing-library/react';

import { ActivityList } from '@/components/sidebar/ActivityList';
import { TooltipProvider } from '@/components/ui/tooltip';
import { buildActivity } from '@/data/activities/testing';

function renderList(activities: ReturnType<typeof buildActivity>[]) {
  return render(
    <TooltipProvider>
      <ActivityList
        activities={activities}
        progress={{}}
        runnerOffline={false}
        now={Date.parse('2026-11-20T10:10:00.000Z')}
        canRetry={() => false}
        onRetry={() => {}}
        onDismiss={() => {}}
        onClearFinished={() => {}}
      />
    </TooltipProvider>,
  );
}

describe('ActivityList', () => {
  test('an implicit destructive cleanup shows the badge, the marker and its effects', () => {
    renderList([
      buildActivity({
        id: 'c1',
        kind: 'workspace.cleanup',
        title: 'Clean up worktree feature',
        status: 'succeeded',
        origin: 'implicit',
        endedAt: '2026-11-20T10:05:00.000Z',
        effects: [
          { effect: 'worktree-removed', target: '/wt/feature' },
          { effect: 'branch-deleted', target: 'feature' },
        ],
      }),
    ]);
    expect(screen.getByTestId('activity-item-automatic-c1')).toHaveTextContent(
      /Automatic|activity\.automatic/,
    );
    expect(screen.getByTestId('activity-item-destructive-c1')).toBeInTheDocument();
    const effects = screen.getByTestId('activity-item-effects-c1');
    expect(effects).toHaveTextContent(
      /(Worktree removed|activity\.effects\.worktree-removed): \/wt\/feature/,
    );
    expect(effects).toHaveTextContent(
      /(Branch deleted|activity\.effects\.branch-deleted): feature/,
    );
  });

  test('a user-started clone has no badge, marker or effects', () => {
    renderList([
      buildActivity({ id: 'u1', status: 'succeeded', endedAt: '2026-11-20T10:05:00.000Z' }),
    ]);
    expect(screen.queryByTestId('activity-item-automatic-u1')).toBeNull();
    expect(screen.queryByTestId('activity-item-destructive-u1')).toBeNull();
    expect(screen.queryByTestId('activity-item-effects-u1')).toBeNull();
  });
});
