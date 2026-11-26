import { describe, expect, test } from 'bun:test';

import { TOOL_PANELS, type ToolPanelContext, findToolPanel } from '@/lib/tool-panels/registry';

const ctx = (patch: Partial<ToolPanelContext> = {}): ToolPanelContext => ({
  hasThread: true,
  projectId: 'p1',
  scratch: false,
  canShowGit: true,
  canShowComments: true,
  ...patch,
});

const available = (c: ToolPanelContext) =>
  TOOL_PANELS.filter((p) => p.isAvailable(c)).map((p) => p.id);

describe('tool panel registry', () => {
  test('ids and Alt keys are unique', () => {
    const ids = TOOL_PANELS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const keys = TOOL_PANELS.flatMap((p) => (p.altKey ? [p.altKey] : []));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain('h'); // Alt+H is the share dialog
  });

  test('looks panels up by id', () => {
    expect(findToolPanel('files')?.id).toBe('files');
    expect(findToolPanel('tests')).toBeUndefined();
    expect(findToolPanel(null)).toBeUndefined();
  });

  test('a project thread with git has every panel', () => {
    expect(available(ctx())).toEqual(['review', 'files', 'comments', 'activity']);
  });

  test('a scratch thread has no review or files', () => {
    expect(
      available(ctx({ scratch: true, projectId: null, canShowGit: false, canShowComments: false })),
    ).toEqual(['activity']);
  });

  test('a read-only share without git view has no review', () => {
    expect(available(ctx({ canShowGit: false }))).toEqual(['files', 'comments', 'activity']);
  });

  test('compose mode on a project has review but no comments', () => {
    expect(available(ctx({ hasThread: false, canShowGit: false, canShowComments: false }))).toEqual(
      ['review', 'files', 'activity'],
    );
  });
});
