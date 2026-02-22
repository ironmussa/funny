import { describe, test, expect, vi, beforeEach } from 'vitest';
import { statusConfig, stageConfig, timeAgo, gitSyncStateConfig, getStatusLabels } from '@/lib/thread-utils';
import type { ThreadStatus, GitSyncState, ThreadStage } from '@funny/shared';

// A mock translation function that returns the key and any interpolation options
const t = (key: string, opts?: any) => (opts ? `${key}:${JSON.stringify(opts)}` : key);

describe('statusConfig', () => {
  const allStatuses: ThreadStatus[] = [
    'idle',
    'pending',
    'running',
    'waiting',
    'completed',
    'failed',
    'stopped',
    'interrupted',
  ];

  test('has an entry for every ThreadStatus', () => {
    for (const status of allStatuses) {
      expect(statusConfig[status]).toBeDefined();
    }
  });

  test('each entry has an icon component', () => {
    for (const status of allStatuses) {
      const { icon } = statusConfig[status];
      expect(icon).toBeDefined();
      // Lucide icons are ForwardRef objects with a render function
      expect(typeof icon === 'function' || typeof icon === 'object').toBe(true);
    }
  });

  test('each entry has a className string', () => {
    for (const status of allStatuses) {
      expect(typeof statusConfig[status].className).toBe('string');
      expect(statusConfig[status].className.length).toBeGreaterThan(0);
    }
  });

  test('running has animate-spin class', () => {
    expect(statusConfig.running.className).toContain('animate-spin');
  });

  test('completed has green color class', () => {
    expect(statusConfig.completed.className).toContain('green');
  });

  test('failed has red color class', () => {
    expect(statusConfig.failed.className).toContain('red');
  });

  test('pending has yellow color class', () => {
    expect(statusConfig.pending.className).toContain('yellow');
  });
});

describe('stageConfig', () => {
  const allStages: ThreadStage[] = ['backlog', 'planning', 'in_progress', 'review', 'done', 'archived'];

  test('has an entry for every ThreadStage', () => {
    for (const stage of allStages) {
      expect(stageConfig[stage]).toBeDefined();
    }
  });

  test('each entry has an icon component', () => {
    for (const stage of allStages) {
      const { icon } = stageConfig[stage];
      expect(icon).toBeDefined();
      // Lucide icons are ForwardRef objects with a render function
      expect(typeof icon === 'function' || typeof icon === 'object').toBe(true);
    }
  });

  test('each entry has a className string', () => {
    for (const stage of allStages) {
      expect(typeof stageConfig[stage].className).toBe('string');
      expect(stageConfig[stage].className.length).toBeGreaterThan(0);
    }
  });

  test('each entry has a labelKey string', () => {
    for (const stage of allStages) {
      expect(typeof stageConfig[stage].labelKey).toBe('string');
      expect(stageConfig[stage].labelKey).toContain('kanban.');
    }
  });

  test('done has green color class', () => {
    expect(stageConfig.done.className).toContain('green');
  });

  test('in_progress has blue color class', () => {
    expect(stageConfig.in_progress.className).toContain('blue');
  });

  test('review has amber color class', () => {
    expect(stageConfig.review.className).toContain('amber');
  });
});

describe('timeAgo', () => {
  test('returns "now" key for less than 60 seconds ago', () => {
    const now = new Date().toISOString();
    const result = timeAgo(now, t);
    expect(result).toBe('time.now');
  });

  test('returns "now" key for 30 seconds ago', () => {
    const date = new Date(Date.now() - 30 * 1000).toISOString();
    const result = timeAgo(date, t);
    expect(result).toBe('time.now');
  });

  test('returns "minutes" key for 1 minute ago', () => {
    const date = new Date(Date.now() - 60 * 1000).toISOString();
    const result = timeAgo(date, t);
    expect(result).toContain('time.minutes');
    expect(result).toContain('"count":1');
  });

  test('returns "minutes" key for 30 minutes ago', () => {
    const date = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const result = timeAgo(date, t);
    expect(result).toContain('time.minutes');
    expect(result).toContain('"count":30');
  });

  test('returns "minutes" key for 59 minutes ago', () => {
    const date = new Date(Date.now() - 59 * 60 * 1000).toISOString();
    const result = timeAgo(date, t);
    expect(result).toContain('time.minutes');
    expect(result).toContain('"count":59');
  });

  test('returns "hours" key for 1 hour ago', () => {
    const date = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const result = timeAgo(date, t);
    expect(result).toContain('time.hours');
    expect(result).toContain('"count":1');
  });

  test('returns "hours" key for 12 hours ago', () => {
    const date = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    const result = timeAgo(date, t);
    expect(result).toContain('time.hours');
    expect(result).toContain('"count":12');
  });

  test('returns "hours" key for 23 hours ago', () => {
    const date = new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString();
    const result = timeAgo(date, t);
    expect(result).toContain('time.hours');
    expect(result).toContain('"count":23');
  });

  test('returns "days" key for 1 day ago', () => {
    const date = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const result = timeAgo(date, t);
    expect(result).toContain('time.days');
    expect(result).toContain('"count":1');
  });

  test('returns "days" key for 15 days ago', () => {
    const date = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    const result = timeAgo(date, t);
    expect(result).toContain('time.days');
    expect(result).toContain('"count":15');
  });

  test('returns "days" key for 29 days ago', () => {
    const date = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString();
    const result = timeAgo(date, t);
    expect(result).toContain('time.days');
    expect(result).toContain('"count":29');
  });

  test('returns "months" key for 30 days ago', () => {
    const date = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const result = timeAgo(date, t);
    expect(result).toContain('time.months');
    expect(result).toContain('"count":1');
  });

  test('returns "months" key for 90 days ago', () => {
    const date = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const result = timeAgo(date, t);
    expect(result).toContain('time.months');
    expect(result).toContain('"count":3');
  });

  test('returns "months" key for 365 days ago', () => {
    const date = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const result = timeAgo(date, t);
    expect(result).toContain('time.months');
    expect(result).toContain('"count":12');
  });
});

describe('gitSyncStateConfig', () => {
  const allStates: GitSyncState[] = ['dirty', 'unpushed', 'pushed', 'merged', 'clean'];

  test('has an entry for every GitSyncState', () => {
    for (const state of allStates) {
      expect(gitSyncStateConfig[state]).toBeDefined();
    }
  });

  test('each entry has an icon component', () => {
    for (const state of allStates) {
      const { icon } = gitSyncStateConfig[state];
      expect(icon).toBeDefined();
      // Lucide icons are ForwardRef objects with a render function
      expect(typeof icon === 'function' || typeof icon === 'object').toBe(true);
    }
  });

  test('each entry has a className string', () => {
    for (const state of allStates) {
      expect(typeof gitSyncStateConfig[state].className).toBe('string');
      expect(gitSyncStateConfig[state].className.length).toBeGreaterThan(0);
    }
  });

  test('each entry has a labelKey string', () => {
    for (const state of allStates) {
      expect(typeof gitSyncStateConfig[state].labelKey).toBe('string');
      expect(gitSyncStateConfig[state].labelKey).toContain('gitStatus.');
    }
  });

  test('dirty has muted foreground class', () => {
    expect(gitSyncStateConfig.dirty.className).toContain('text-muted-foreground');
  });

  test('clean has muted foreground class', () => {
    expect(gitSyncStateConfig.clean.className).toContain('text-muted-foreground');
  });

  test('pushed has muted foreground class', () => {
    expect(gitSyncStateConfig.pushed.className).toContain('text-muted-foreground');
  });

  test('merged has muted foreground class', () => {
    expect(gitSyncStateConfig.merged.className).toContain('text-muted-foreground');
  });
});

describe('getStatusLabels', () => {
  const allStatuses: ThreadStatus[] = [
    'idle',
    'pending',
    'running',
    'waiting',
    'completed',
    'failed',
    'stopped',
    'interrupted',
  ];

  test('returns a label for every ThreadStatus', () => {
    const labels = getStatusLabels(t);
    for (const status of allStatuses) {
      expect(labels[status]).toBeDefined();
      expect(typeof labels[status]).toBe('string');
    }
  });

  test('uses the translation function for each label', () => {
    const labels = getStatusLabels(t);
    expect(labels.idle).toBe('thread.status.idle');
    expect(labels.pending).toBe('thread.status.pending');
    expect(labels.running).toBe('thread.status.running');
    expect(labels.waiting).toBe('thread.status.waiting');
    expect(labels.completed).toBe('thread.status.completed');
    expect(labels.failed).toBe('thread.status.failed');
    expect(labels.stopped).toBe('thread.status.stopped');
    expect(labels.interrupted).toBe('thread.status.interrupted');
  });

  test('returns correct number of entries', () => {
    const labels = getStatusLabels(t);
    expect(Object.keys(labels)).toHaveLength(allStatuses.length);
  });

  test('calls translation function with correct keys', () => {
    const mockT = vi.fn((key: string) => key);
    getStatusLabels(mockT);
    expect(mockT).toHaveBeenCalledTimes(8);
    expect(mockT).toHaveBeenCalledWith('thread.status.idle');
    expect(mockT).toHaveBeenCalledWith('thread.status.completed');
    expect(mockT).toHaveBeenCalledWith('thread.status.failed');
  });
});
