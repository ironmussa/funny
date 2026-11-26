import { describe, expect, test } from 'bun:test';

import {
  ACTIVITY_EFFECTS_MAX,
  ACTIVITY_EFFECT_TARGET_MAX,
  ACTIVITY_KINDS,
  isDestructiveKind,
  parseActivityEffects,
  parseActivityInput,
  recordsOnlyFailures,
  stripUrlCredentials,
} from '../activities/kinds.js';
import type { JsonObject } from '../json.js';

// Built from parts so secret scanners do not read the fixture as a real credential.
const URL_WITH_CREDENTIALS = ['https://', 'user', ':', 'token', '@github.com/org/repo.git'].join(
  '',
);

describe('stripUrlCredentials', () => {
  test('removes user and token from an https URL', () => {
    expect(stripUrlCredentials(URL_WITH_CREDENTIALS)).toBe('https://github.com/org/repo.git');
  });

  test('removes a lone token', () => {
    expect(stripUrlCredentials('https://ghp_abc@github.com/org/repo.git')).toBe(
      'https://github.com/org/repo.git',
    );
  });

  test('keeps a URL without credentials', () => {
    expect(stripUrlCredentials('https://github.com/org/repo.git')).toBe(
      'https://github.com/org/repo.git',
    );
    expect(stripUrlCredentials('git@github.com:org/repo.git')).toBe('git@github.com:org/repo.git');
  });
});

describe('parseActivityInput', () => {
  test('drops undeclared fields', () => {
    const input = parseActivityInput({
      kind: 'project.clone',
      input: {
        cloneUrl: 'https://github.com/org/repo.git',
        destinationPath: '/tmp/repo',
        token: 'ghp_secret',
      },
    });
    expect(input).toEqual({
      cloneUrl: 'https://github.com/org/repo.git',
      destinationPath: '/tmp/repo',
    });
  });

  test('strips credentials from the clone URL', () => {
    const input = parseActivityInput({
      kind: 'project.clone',
      input: {
        cloneUrl: URL_WITH_CREDENTIALS,
        destinationPath: '/tmp/repo',
      },
    });
    expect(input?.cloneUrl).toBe('https://github.com/org/repo.git');
  });

  test('refuses an unknown kind', () => {
    expect(parseActivityInput({ kind: 'project.delete', input: {} })).toBeNull();
    expect(parseActivityInput({ kind: 'toString', input: {} })).toBeNull();
  });

  test('refuses an input that does not match its kind', () => {
    expect(parseActivityInput({ kind: 'git.workflow', input: { action: 'rm -rf' } })).toBeNull();
  });
});

describe('kind metadata', () => {
  test('a destructive kind records every run', () => {
    for (const [kind, spec] of Object.entries(ACTIVITY_KINDS)) {
      if (spec.destructive)
        expect({ kind, record: spec.record }).toEqual({ kind, record: 'always' });
    }
  });

  test('routine sandbox actions record only failures', () => {
    expect(recordsOnlyFailures('sandbox.stop')).toBe(true);
    expect(recordsOnlyFailures('sandbox.wake')).toBe(true);
    expect(recordsOnlyFailures('workspace.cleanup')).toBe(false);
    expect(recordsOnlyFailures('nope')).toBe(false);
  });

  test('destructive marker', () => {
    expect(isDestructiveKind('workspace.cleanup')).toBe(true);
    expect(isDestructiveKind('project.clone')).toBe(false);
    expect(isDestructiveKind('nope')).toBe(false);
  });
});

describe('parseActivityInput for the new kinds', () => {
  const samples: Record<string, JsonObject> = {
    'workspace.cleanup': { reason: 'thread-archived', branch: 'b', deleteBranch: true },
    'workspace.prune': {},
    'checkout.switch': { fromBranch: 'a', toBranch: 'b', stashed: false, reason: 'merged' },
    'sandbox.provision': { connectionId: 'conn-1' },
    'sandbox.stop': { reason: 'idle' },
    'sandbox.wake': {},
    'sandbox.destroy': { reason: 'thread-deleted' },
    'factory.merge': { issueNumber: 3, prNumber: 9 },
    'factory.close-pr': { issueNumber: 3, prNumber: 9, replacedBy: 11 },
    'factory.disabled': { reason: 'access-lost' },
    'factory.trigger_skipped': {
      triggerId: 't1',
      flowName: 'audit',
      due: '2026-11-23T02:05:00.000Z',
    },
    'factory.stop': { issueNumber: 3 },
    'factory.retry': { issueNumber: 3 },
    'factory.split': { issueNumber: 3 },
    'factory.close_parent': { issueNumber: 464, parts: [542, 544] },
    'factory.approve-merge': { issueNumber: 3, sha: 'abc1234' },
    'factory.approval-moved': {
      issueNumber: 3,
      from: 'abc1234',
      to: 'def5678',
      change: 'adjustment',
      lines: 7,
      files: ['src/a.ts'],
    },
    'agents.stopped': { reason: 'runner-binding-changed' },
    'automation.unscheduled': { automationId: 'a1', schedule: 'every morning' },
    'automation.skipped': { automationId: 'a1', runningSince: '2026-11-22T10:00:00.000Z' },
    'github.write': { action: 'pr-merge', prNumber: 7, repo: 'o/r' },
    'git.destructive': { action: 'discard', paths: ['a.ts', 'b.ts'] },
    'pipeline.run': { pipelineId: 'pl1', commitSha: 'abc123' },
    'factory.mark-done': { issueNumber: 12 },
    'factory.hold': { issueNumber: 12 },
    'factory.release': { issueNumber: 12 },
    'factory.lane_sync': {
      lane: 'payments',
      branch: 'feature/payments',
      event: 'conflict',
      to: 'resolving',
      prNumber: 81,
    },
    'factory.finish_lane': {
      lane: 'payments',
      branch: 'feature/payments',
      base: 'dev',
      prNumber: 90,
      stage: 'opened',
    },
  };

  test('every kind has a sample', () => {
    const declared = Object.keys(ACTIVITY_KINDS).filter(
      (k) => !['project.clone', 'worktree.setup', 'git.workflow'].includes(k),
    );
    expect(Object.keys(samples).sort()).toEqual(declared.sort());
  });

  for (const [kind, input] of Object.entries(samples)) {
    test(`${kind} drops undeclared fields`, () => {
      expect(parseActivityInput({ kind, input: { ...input, token: 'ghp_secret' } })).toEqual(input);
    });
  }

  test('refuses an unknown cleanup reason', () => {
    expect(
      parseActivityInput({
        kind: 'workspace.cleanup',
        input: { reason: 'because', deleteBranch: false },
      }),
    ).toBeNull();
  });
});

describe('git.destructive input', () => {
  test('keeps at most 50 paths', () => {
    const paths = Array.from({ length: 80 }, (_, i) => `f${i}.ts`);
    const input = parseActivityInput({
      kind: 'git.destructive',
      input: { action: 'discard', paths },
    });
    expect(input?.paths).toHaveLength(50);
  });

  test('refuses an unknown action', () => {
    expect(parseActivityInput({ kind: 'git.destructive', input: { action: 'rm-rf' } })).toBeNull();
  });
});

describe('parseActivityEffects', () => {
  test('drops unknown effects and extra fields', () => {
    expect(
      parseActivityEffects({
        effects: [
          { effect: 'worktree-removed', target: '/w', extra: 1 },
          { effect: 'rm-rf', target: '/' },
          'nope',
        ],
      }),
    ).toEqual([{ effect: 'worktree-removed', target: '/w' }]);
  });

  test('caps the list and each target', () => {
    const many = Array.from({ length: 30 }, () => ({
      effect: 'branch-deleted',
      target: 'x'.repeat(1000),
    }));
    const parsed = parseActivityEffects({ effects: many });
    expect(parsed).toHaveLength(ACTIVITY_EFFECTS_MAX);
    expect(parsed?.[0]?.target).toHaveLength(ACTIVITY_EFFECT_TARGET_MAX);
  });

  test('keeps the effects of this change', () => {
    const effects = ['changes-discarded', 'snapshot-saved', 'repo-published'].map((effect) => ({
      effect,
      target: 'x',
    }));
    expect(parseActivityEffects({ effects })).toHaveLength(3);
  });

  test('anything but a list is null', () => {
    expect(parseActivityEffects({ effects: undefined })).toBeNull();
    expect(parseActivityEffects({ effects: { effect: 'branch-deleted' } })).toBeNull();
  });
});
