/**
 * What a factory flow may say about its agent steps (openspec
 * factory-flow-step-options, tasks 2.2-2.4): every refusal names its step and
 * field, today's built-ins still load, tool lists only reach providers that
 * apply them, and a repository flow and its prompt files are read at one
 * default-branch commit.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { interpolate } from '@funny/pipelines/templates';
import { parseWorkflowYaml } from '@funny/workflows';
import { ok } from 'neverthrow';

import { flowInputsOf } from '../../../services/factory/factory-flow-runs.js';
import {
  requiredFlowInputs,
  TOOL_POLICY_PROVIDERS,
  validateFlowForIssuelessRun,
} from '../../../services/factory/factory-flow-validation.js';
import { loadFactoryFlow, type FactoryFlowError } from '../../../services/factory/factory-flow.js';

const HEADER = `name: custom
nodes:
`;

/** A repository whose default branch is at `head-sha`, holding `files`; reads are recorded. */
function repository(files: Record<string, string>) {
  const reads: Array<{ path: string; ref: string }> = [];
  return {
    reads,
    deps: {
      readDefaultBranchFile: async (path: string) => ok(files[path] ?? null),
      defaultBranchHead: async () => ok({ branch: 'main', sha: 'head-sha' }),
      readFileAt: async (path: string, ref: string) => {
        reads.push({ path, ref });
        return ok(ref === 'head-sha' ? (files[path] ?? null) : 'a later edit');
      },
    },
  };
}

async function load(nodes: string, extra: Record<string, string> = {}) {
  const repo = repository({ '.funny/workflows/custom.yaml': HEADER + nodes, ...extra });
  return loadFactoryFlow('custom', repo.deps);
}

/** The refusal, narrowed to the invalid kind that carries problems. */
function invalid(error: FactoryFlowError) {
  if (error.kind !== 'invalid') throw new Error(`expected an invalid flow, got ${error.kind}`);
  return error;
}

async function problems(nodes: string) {
  const flow = await load(nodes);
  if (flow.isOk()) throw new Error('expected the flow to be refused');
  return invalid(flow.error);
}

describe('refused options name the step and the field', () => {
  test('a permission mode that waits for a person', async () => {
    const error = await problems(`  - id: implement
    spawn_agent: { prompt: go, permission_mode: ask }
`);
    expect(error.problems).toEqual([
      { step: 'implement', field: 'permission_mode', message: expect.stringContaining('ask') },
    ]);
    expect(error.message).toContain('step implement, permission_mode');
  });

  test('confirmEdit and auto are refused, also in defaults', async () => {
    const confirm = await problems(`  - id: implement
    spawn_agent: { prompt: go, permission_mode: confirmEdit }
`);
    expect(confirm.problems?.[0]).toMatchObject({ field: 'permission_mode' });
    const flow = await loadFactoryFlow(
      'custom',
      repository({
        '.funny/workflows/custom.yaml': `name: custom
defaults: { permission_mode: auto }
nodes:
  - id: implement
    spawn_agent: { prompt: go }
`,
      }).deps,
    );
    expect(invalid(flow._unsafeUnwrapErr()).problems).toContainEqual({
      step: 'defaults',
      field: 'permission_mode',
      message: expect.stringContaining('auto'),
    });
  });

  test('a field the factory does not apply', async () => {
    const error = await problems(`  - id: implement
    spawn_agent:
      prompt: go
      output_format: { type: object, properties: {} }
`);
    expect(error.problems).toEqual([
      { step: 'implement', field: 'output_format', message: expect.any(String) },
    ]);
  });

  test('a tool list on a provider that cannot apply it, naming the provider', async () => {
    const error = await problems(`  - id: implement
    spawn_agent: { prompt: go, provider: codex, denied_tools: [Bash] }
`);
    expect(error.problems).toEqual([
      { step: 'implement', field: 'denied_tools', message: expect.stringContaining('codex') },
    ]);
  });

  test('a tool list from defaults on such a provider is refused too', async () => {
    const flow = await loadFactoryFlow(
      'custom',
      repository({
        '.funny/workflows/custom.yaml': `name: custom
defaults: { denied_tools: [WebFetch] }
nodes:
  - id: implement
    spawn_agent: { prompt: go, provider: codex }
`,
      }).deps,
    );
    expect(invalid(flow._unsafeUnwrapErr()).problems).toEqual([
      { step: 'implement', field: 'denied_tools', message: expect.stringContaining('codex') },
    ]);
  });

  test('a model the provider does not have', async () => {
    const error = await problems(`  - id: implement
    spawn_agent: { prompt: go, provider: codex, model: opus }
`);
    expect(error.problems).toEqual([
      { step: 'implement', field: 'model', message: expect.stringContaining('opus') },
    ]);
  });

  test('thread: new on a step that writes, or on the first agent step', async () => {
    const writing = await problems(`  - id: implement
    spawn_agent: { prompt: go }
  - id: advise
    depends_on: [implement]
    spawn_agent: { prompt: look, thread: new }
`);
    expect(writing.problems).toEqual([
      { step: 'advise', field: 'thread', message: expect.stringContaining('plan') },
    ]);
    const first = await problems(`  - id: advise
    spawn_agent: { prompt: look, thread: new, permission_mode: plan }
`);
    expect(first.problems).toEqual([
      { step: 'advise', field: 'thread', message: expect.stringContaining('first agent step') },
    ]);
  });

  test('thread: new on a provider the runner cannot hold to read-only', async () => {
    const error = await problems(`  - id: implement
    spawn_agent: { prompt: go }
  - id: advise
    depends_on: [implement]
    spawn_agent: { prompt: look, thread: new, permission_mode: plan, provider: gemini }
`);
    expect(error.problems).toEqual([
      { step: 'advise', field: 'provider', message: expect.stringContaining('gemini') },
    ]);
  });

  test('every problem is reported at once', async () => {
    const error = await problems(`  - id: implement
    spawn_agent: { prompt: go, permission_mode: ask }
  - id: ci
    depends_on: [implement]
    wait_ci: {}
    retry:
      max_attempts: 2
      before_retry: { prompt: fix, provider: codex, allowed_tools: [Read] }
`);
    expect(error.problems?.map((p) => `${p.step}/${p.field}`)).toEqual([
      'implement/permission_mode',
      'ci.before_retry/allowed_tools',
    ]);
  });

  test('accepted options load: autoEdit, plan on a read-only new thread, tools on claude', async () => {
    const flow = await load(`  - id: implement
    spawn_agent:
      prompt: go
      model: opus
      effort: high
      permission_mode: autoEdit
      denied_tools: [WebFetch]
  - id: advise
    depends_on: [implement]
    spawn_agent: { prompt: look, thread: new, permission_mode: plan, provider: codex }
`);
    expect(flow.isOk()).toBe(true);
  });
});

describe("today's built-in flows", () => {
  test.each(['issue-to-merge', 'issue-to-pr'])('%s still loads', async (name) => {
    const flow = await loadFactoryFlow(name, {
      readDefaultBranchFile: async () => ok(null),
    });
    expect(flow.isOk()).toBe(true);
    expect(flow._unsafeUnwrap()).toMatchObject({ source: 'built-in', commit: null });
  });
});

describe('the tool-policy providers', () => {
  // A provider on the list must keep applying the deny-list in its agent
  // process; if it stops, a flow's restriction would be dropped without a word.
  const processes: Record<string, string> = {
    claude: 'packages/core/src/agents/sdk-claude.ts',
    pi: 'packages/core/src/agents/pi-sdk.ts',
  };

  test.each([...TOOL_POLICY_PROVIDERS])('%s reads disallowedTools', (provider) => {
    const file = processes[provider];
    if (!file) throw new Error(`no agent process listed for tool-policy provider ${provider}`);
    const source = readFileSync(join(import.meta.dir, '../../../../../..', file), 'utf8');
    expect(source).toContain('disallowedTools');
  });
});

describe('reading a repository flow at one commit', () => {
  const FLOW = `${HEADER}  - id: implement
    spawn_agent: { prompt_file: prompts/implement.md }
`;

  test('the flow and its prompt files are read at the default branch head, which is recorded', async () => {
    const repo = repository({
      '.funny/workflows/custom.yaml': FLOW,
      '.funny/workflows/prompts/implement.md': 'Implement #{{issue_number}}',
    });
    const flow = await loadFactoryFlow('custom', repo.deps);
    expect(flow._unsafeUnwrap()).toMatchObject({ source: 'repository', commit: 'head-sha' });
    expect(flow._unsafeUnwrap().workflow.nodes[0]!.spawn_agent?.prompt).toBe(
      'Implement #{{issue_number}}',
    );
    expect(repo.reads).toEqual([
      { path: '.funny/workflows/custom.yaml', ref: 'head-sha' },
      { path: '.funny/workflows/prompts/implement.md', ref: 'head-sha' },
    ]);
  });

  test('a missing prompt file refuses the flow, naming the path', async () => {
    const repo = repository({ '.funny/workflows/custom.yaml': FLOW });
    const error = invalid((await loadFactoryFlow('custom', repo.deps))._unsafeUnwrapErr());
    expect(error.kind).toBe('invalid');
    expect(error.problems).toEqual([
      {
        step: 'implement',
        field: 'prompt_file',
        message: expect.stringContaining('prompts/implement.md'),
      },
    ]);
  });

  test('a path leaving the workflows directory is refused without reading it', async () => {
    const repo = repository({
      '.funny/workflows/custom.yaml': `${HEADER}  - id: implement
    spawn_agent: { prompt_file: ../../secrets.txt }
`,
    });
    const error = invalid((await loadFactoryFlow('custom', repo.deps))._unsafeUnwrapErr());
    expect(error.message).toContain('../../secrets.txt');
    expect(repo.reads.map((read) => read.path)).toEqual(['.funny/workflows/custom.yaml']);
  });

  test('without a commit reader, the branch is read by name and no commit is recorded', async () => {
    const flow = await loadFactoryFlow('custom', {
      readDefaultBranchFile: async (path: string) =>
        ok(
          path === '.funny/workflows/custom.yaml'
            ? `${HEADER}  - id: a\n    spawn_agent: { prompt: go }\n`
            : null,
        ),
    });
    expect(flow._unsafeUnwrap().commit).toBeNull();
  });
});

describe('a flow for a run without an issue (change flow-triggers)', () => {
  const parse = (yaml: string) => {
    const parsed = parseWorkflowYaml(yaml);
    if (!parsed.ok) throw new Error('the test flow does not parse');
    return parsed.workflow;
  };

  const AUDIT = `name: audit
inputs:
  scope: { type: string, required: true }
  depth: { type: string, required: true, default: shallow }
  note: { type: string }
  repo: { type: string, required: true }
nodes:
  - id: look
    spawn_agent:
      prompt: 'Audit {{scope}}'
`;

  test('only inputs that are required and have no default must be supplied', () => {
    expect(requiredFlowInputs(parse(AUDIT))).toEqual(['scope', 'repo']);
  });

  test('a flow whose required inputs are supplied has no problem; the factory supplies its own', () => {
    expect(validateFlowForIssuelessRun(parse(AUDIT), ['scope'])).toEqual([]);
  });

  test('a required input nobody supplies is named', () => {
    const problems = validateFlowForIssuelessRun(parse(AUDIT), []);
    expect(problems).toEqual([expect.objectContaining({ step: 'flow', field: 'inputs.scope' })]);
  });

  test('every step that judges a change against an issue is named', () => {
    const builtIn = parse(
      readFileSync(
        join(import.meta.dir, '../../../../../workflows/defaults/issue-to-merge.yaml'),
        'utf8',
      ),
    );
    const fields = validateFlowForIssuelessRun(builtIn, []).map((problem) => problem.field);
    expect(fields).toEqual(
      expect.arrayContaining([
        'triage',
        'review',
        'regression_proof',
        'merge',
        'inputs.issue_number',
      ]),
    );
  });

  const at = { branch: 'factory/run-1', baseBranch: 'main' };
  const factory = { id: 'f1' };

  test('an issue run gets its issue as inputs', () => {
    const issue = { number: 12, title: 'Fix login', url: 'u/12' };
    expect(flowInputsOf({ repo: 'o/r', issue, factory, run: { inputs: {} } }, at)).toEqual({
      issue_number: '12',
      issue_title: 'Fix login',
      issue_url: 'u/12',
      repo: 'o/r',
      branch: 'factory/run-1',
      base_branch: 'main',
      factory_id: 'f1',
      stack_branch: '',
      spec: '',
      spec_commit_path: '',
    });
  });

  test('a run with an approved spec gets it, and where to commit it (factory-spec-stage)', () => {
    const issue = { number: 12, title: 'Fix login', url: 'u/12' };
    const spec = {
      summary: 'Add a logout button',
      decisions: [{ question: 'Where?', answer: 'In the user menu' }],
      behavior: ['The menu shows Log out'],
      approach: [],
      outOfScope: ['Single sign-out'],
      validation: ['Log out ends the session'],
      contract: { acceptanceCriteria: ['A user can log out'], likelyPaths: [], riskHints: [] },
    };
    const run = {
      inputs: {},
      spec: { revision: 2, approved: { spec, revision: 2, by: 'u1', at: '2026-11-26T00:00:00Z' } },
    };
    const inputs = flowInputsOf(
      { repo: 'o/r', issue, factory: { id: 'f1', commitSpecPath: 'docs/specs' }, run },
      at,
    );
    expect(inputs.spec).toContain('Where? — In the user menu');
    expect(inputs.spec).toContain('Log out ends the session');
    expect(inputs.spec_commit_path).toBe('docs/specs/issue-12.md');
  });

  test('the built-in implement prompt carries the approved spec, and nothing without one', () => {
    const template = readFileSync(
      join(import.meta.dir, '../../../../../workflows/defaults/prompts/implement.md'),
      'utf8',
    );
    const base = {
      issue_number: '12',
      repo: 'o/r',
      issue_title: 'Fix login',
      issue_url: 'u/12',
      branch: 'factory/issue-12',
      base_branch: 'main',
      stack_branch: '',
    };
    const withSpec = interpolate(template, {
      ...base,
      spec: '# Approved spec\n\n- Where? — In the user menu',
      spec_commit_path: 'docs/specs/issue-12.md',
    });
    expect(withSpec).toContain('Its\ndecisions are not yours to change');
    expect(withSpec).toContain('- Where? — In the user menu');
    expect(withSpec).toContain('`docs/specs/issue-12.md`');
    const without = interpolate(template, { ...base, spec: '', spec_commit_path: '' });
    expect(without).not.toContain('approved this spec');
    expect(without).not.toContain('Commit this spec');
  });

  test('a spec not approved yet reaches no prompt', () => {
    const issue = { number: 12, title: 'Fix login', url: 'u/12' };
    const run = { inputs: {}, spec: { revision: 1 } };
    const inputs = flowInputsOf(
      { repo: 'o/r', issue, factory: { id: 'f1', commitSpecPath: 'docs/specs' }, run },
      at,
    );
    expect(inputs).toMatchObject({ spec: '', spec_commit_path: '' });
  });

  test('a run without an issue gets what its trigger recorded; the factory inputs win', () => {
    const run = { inputs: { scope: 'auth', repo: 'evil/repo', branch: 'main' } };
    expect(flowInputsOf({ repo: 'o/r', issue: null, factory, run }, at)).toEqual({
      scope: 'auth',
      repo: 'o/r',
      branch: 'factory/run-1',
      base_branch: 'main',
      factory_id: 'f1',
      stack_branch: '',
      spec: '',
      spec_commit_path: '',
    });
  });
});
