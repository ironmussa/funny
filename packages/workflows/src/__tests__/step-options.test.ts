/**
 * Per-step agent options (openspec factory-flow-step-options, tasks 1.1-1.3):
 * the `spawn_agent` fields a flow may set, the `defaults:` block, what the
 * compiler hands the provider for a node and for a retry's fixer agent, and
 * `prompt_file` resolution.
 */

import { describe, expect, test } from 'bun:test';

import { nullReporter, runPipeline } from '@funny/pipelines';

import type { ActionProvider, ActionResult, SpawnAgentOpts } from '../compiler/action-provider.js';
import { compileYamlPipeline } from '../compiler/yaml-compiler.js';
import { parseWorkflowYaml } from '../parse.js';
import { normalizePromptPath, resolvePromptFiles } from '../prompt-files.js';
import type { ParsedWorkflow } from '../schema.js';

const ok: ActionResult = { ok: true, output: '' };

function parse(yaml: string): ParsedWorkflow {
  const result = parseWorkflowYaml(yaml);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.workflow;
}

function parseErrors(yaml: string): string {
  const result = parseWorkflowYaml(yaml);
  if (result.ok) throw new Error('expected a parse error');
  return JSON.stringify(result);
}

/** A provider that records every spawn and fails `run_command` once. */
function recorder() {
  const spawns: SpawnAgentOpts[] = [];
  let commands = 0;
  const provider: ActionProvider = {
    spawnAgent: async (opts) => {
      spawns.push(opts);
      return ok;
    },
    runCommand: async () =>
      commands++ === 0 ? { ok: false, error: 'boom' } : { ok: true, output: 'fine' },
    gitCommit: async () => ok,
    gitPush: async () => ok,
    createPr: async () => ok,
    notify: async () => ok,
    setStatus: async () => ok,
    setStage: async () => ok,
    requestApproval: async () => ({ decision: 'approve' }),
  };
  return { provider, spawns };
}

async function run(workflow: ParsedWorkflow) {
  const { provider, spawns } = recorder();
  const result = await runPipeline(compileYamlPipeline(workflow), {
    provider,
    progress: nullReporter,
    cwd: '',
    inputs: { who: 'Ana' },
    outputs: {},
  });
  return { spawns, result };
}

const FLOW = `
name: steps
defaults:
  provider: claude
  model: sonnet
  effort: medium
  denied_tools: [WebFetch]
nodes:
  - id: implement
    spawn_agent:
      prompt: 'Implement for {{who}}'
      model: opus
      effort: high
      permission_mode: autoEdit
  - id: check
    depends_on: [implement]
    run_command: { command: 'true' }
    retry:
      max_attempts: 2
      before_retry:
        prompt: 'Fix {{LAST_ERROR}}'
        model: haiku
  - id: advise
    depends_on: [check]
    spawn_agent:
      prompt: 'Review'
      thread: new
      permission_mode: plan
`;

describe('spawn_agent schema', () => {
  test('accepts effort, thread and prompt_file, and the wider defaults block', () => {
    const flow = parse(`
name: ok
defaults: { effort: low, allowed_tools: [Read], denied_tools: [Bash], permission_mode: plan }
nodes:
  - id: a
    spawn_agent: { prompt_file: prompts/a.md, effort: max, thread: new }
`);
    expect(flow.nodes[0]!.spawn_agent).toMatchObject({
      prompt_file: 'prompts/a.md',
      effort: 'max',
      thread: 'new',
    });
    expect(flow.defaults).toMatchObject({ effort: 'low', denied_tools: ['Bash'] });
  });

  test('refuses both prompt and prompt_file', () => {
    expect(
      parseErrors(`
name: both
nodes:
  - id: a
    spawn_agent: { prompt: hi, prompt_file: prompts/a.md }
`),
    ).toContain('not both');
  });

  test('refuses neither prompt nor prompt_file', () => {
    expect(
      parseErrors(`
name: neither
nodes:
  - id: a
    spawn_agent: { model: opus }
`),
    ).toContain('needs a prompt');
  });

  test('refuses an unknown thread value', () => {
    expect(
      parseErrors(`
name: thread
nodes:
  - id: a
    spawn_agent: { prompt: hi, thread: fork }
`),
    ).toContain('thread');
  });
});

describe('what the compiler hands the provider', () => {
  test('a node: its step id and its own options, plus the flow defaults', async () => {
    const { spawns } = await run(parse(FLOW));
    expect(spawns[0]).toMatchObject({
      stepId: 'implement',
      prompt: 'Implement for Ana',
      model: 'opus',
      effort: 'high',
      mode: 'autoEdit',
      defaults: {
        provider: 'claude',
        model: 'sonnet',
        effort: 'medium',
        disallowedTools: ['WebFetch'],
      },
    });
    expect(spawns[0]!.thread).toBeUndefined();
  });

  test('a retry fixer: `<node>.before_retry`, the same for every attempt', async () => {
    const { spawns } = await run(parse(FLOW));
    const fixer = spawns.find((spawn) => spawn.stepId === 'check.before_retry');
    expect(fixer).toMatchObject({ prompt: expect.stringContaining('boom'), model: 'haiku' });
  });

  test('thread and the permission mode as written reach the provider', async () => {
    const { spawns } = await run(parse(FLOW));
    expect(spawns.find((spawn) => spawn.stepId === 'advise')).toMatchObject({
      thread: 'new',
      mode: 'plan',
    });
    const asking = parse(`
name: asking
nodes:
  - id: a
    spawn_agent: { prompt: hi, permission_mode: ask }
`);
    expect((await run(asking)).spawns[0]!.mode).toBe('ask');
  });

  test('an unresolved prompt_file fails the step instead of sending an empty prompt', async () => {
    const flow = parse(`
name: unresolved
nodes:
  - id: a
    spawn_agent: { prompt_file: prompts/a.md }
`);
    const { spawns, result } = await run(flow);
    expect(spawns).toEqual([]);
    expect(result.outcome).not.toBe('completed');
    expect(String(result.error)).toContain('prompt_file is not supported here');
  });
});

describe('prompt files', () => {
  const FILE_FLOW = `
name: files
nodes:
  - id: a
    spawn_agent: { prompt_file: ./prompts/a.md }
  - id: b
    depends_on: [a]
    run_command: { command: 'true' }
    retry:
      max_attempts: 2
      before_retry: { prompt_file: prompts/fix.md }
`;

  test('normalizes a path relative to the flow and refuses anything that leaves it', () => {
    expect(normalizePromptPath('./prompts//a.md')).toEqual({ path: 'prompts/a.md' });
    expect(normalizePromptPath('/etc/passwd')).toMatchObject({ error: expect.any(String) });
    expect(normalizePromptPath('C:/x.md')).toMatchObject({ error: expect.any(String) });
    expect(normalizePromptPath('prompts/../../secret.md')).toMatchObject({
      error: expect.stringContaining('..'),
    });
    expect(normalizePromptPath('prompts\\a.md')).toMatchObject({ error: expect.any(String) });
    expect(normalizePromptPath('  ')).toMatchObject({ error: 'is empty' });
  });

  test('puts each file in place of prompt_file, reads a path once, and the text is templated', async () => {
    const reads: string[] = [];
    const resolved = await resolvePromptFiles(parse(FILE_FLOW), async (path) => {
      reads.push(path);
      return path === 'prompts/a.md' ? 'Hello {{who}}' : 'Fix {{LAST_ERROR}}';
    });
    if (!resolved.ok) throw new Error(JSON.stringify(resolved.problems));
    expect(reads).toEqual(['prompts/a.md', 'prompts/fix.md']);
    expect(resolved.workflow.nodes[0]!.spawn_agent).toEqual({ prompt: 'Hello {{who}}' });
    const { spawns } = await run(resolved.workflow);
    expect(spawns.map((spawn) => spawn.prompt)).toEqual([
      'Hello Ana',
      expect.stringMatching(/^Fix .*boom/),
    ]);
  });

  test('reports every missing or refused file with its step', async () => {
    const flow = parse(`
name: bad
nodes:
  - id: a
    spawn_agent: { prompt_file: ../outside.md }
  - id: b
    depends_on: [a]
    run_command: { command: 'true' }
    retry:
      max_attempts: 2
      before_retry: { prompt_file: prompts/missing.md }
`);
    const resolved = await resolvePromptFiles(flow, async () => null);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.problems).toEqual([
      { step: 'a', field: 'prompt_file', message: expect.stringContaining('..') },
      {
        step: 'b.before_retry',
        field: 'prompt_file',
        message: expect.stringContaining('not found'),
      },
    ]);
  });

  test('a flow without prompt files is returned as it is, without reading', async () => {
    const flow = parse(FLOW);
    const resolved = await resolvePromptFiles(flow, async () => {
      throw new Error('should not read');
    });
    expect(resolved).toEqual({ ok: true, workflow: flow });
  });
});
