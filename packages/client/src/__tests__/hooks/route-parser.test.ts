import { describe, expect, test } from 'vitest';

import { parseRoute } from '@/hooks/route-parser';

describe('parseRoute', () => {
  test('parses project workflow routes outside settings', () => {
    expect(parseRoute('/projects/project-1/workflows')).toMatchObject({
      projectId: 'project-1',
      workflowsProjectId: 'project-1',
      settingsPage: null,
    });
  });

  test('treats the old settings workflow URL as the workflow view', () => {
    expect(parseRoute('/projects/project-1/settings/workflows')).toMatchObject({
      projectId: 'project-1',
      workflowsProjectId: 'project-1',
      settingsPage: null,
    });
  });
});
