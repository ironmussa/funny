import { describe, expect, test } from 'bun:test';

import { parseClientRoute } from '../route-parser';

describe('renderer-neutral route parser', () => {
  test('parses project, scratch, and organization-prefixed threads', () => {
    expect(parseClientRoute('/projects/p1/threads/t1')).toMatchObject({
      orgSlug: null,
      projectId: 'p1',
      threadId: 't1',
    });
    expect(parseClientRoute('/scratch/t2')).toMatchObject({ projectId: null, threadId: 't2' });
    expect(parseClientRoute('/acme/projects/p1/threads/t3')).toMatchObject({
      orgSlug: 'acme',
      projectId: 'p1',
      threadId: 't3',
    });
  });

  test('preserves workflow, settings, and full-screen route precedence', () => {
    expect(parseClientRoute('/projects/p1/settings/workflows')).toMatchObject({
      projectId: 'p1',
      workflowsProjectId: 'p1',
      settingsPage: null,
    });
    expect(parseClientRoute('/projects/p1/settings/git')).toMatchObject({
      projectId: 'p1',
      settingsPage: 'git',
    });
    expect(parseClientRoute('/grid').liveColumns).toBe(true);
  });
});
