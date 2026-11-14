/**
 * The issue factory's default workflow ships as a built-in and parses.
 *
 * What it does when run is tested at the step runner seam
 * (packages/agent, `implement` step); here we only pin what the step runner
 * relies on: its name, its inputs, and a draft pull request against the base.
 */

import { describe, expect, test } from 'vitest';

import { loadWorkflowCatalog } from '../catalog.js';

describe('factory-issue workflow', () => {
  test('is a built-in that parses, with the inputs the step runner supplies', async () => {
    const { workflows, warnings } = await loadWorkflowCatalog();
    const entry = workflows.get('factory-issue');

    expect(warnings).toEqual([]);
    expect(entry?.source).toBe('built-in');
    expect(Object.keys(entry!.workflow.inputs ?? {}).sort()).toEqual([
      'base',
      'branch',
      'check_command',
      'issue_body',
      'issue_number',
      'issue_title',
      'pr_body',
    ]);
  });

  test('opens a draft pull request against the base', async () => {
    const { workflows } = await loadWorkflowCatalog();
    const nodes = workflows.get('factory-issue')!.workflow.nodes;
    const pr = nodes.find((n) => n.create_pr)?.create_pr;

    expect(pr).toMatchObject({ base: '{{base}}', body: '{{pr_body}}', draft: true });
  });
});
