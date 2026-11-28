import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { okAsync } from 'neverthrow';

import {
  runFlowSetupVerification,
  type VerifyFlowSetupDeps,
  type VerifyFlowSetupRequest,
} from '../../services/factory-flow-setup-verify.js';
import type { RunOutcome } from '../../services/regression-proof.js';

const SAMPLE_WORKFLOW_YAML = `name: issue-to-merge
nodes:
  - id: implement
    agent:
      prompt_file: prompts/implement.md
  - id: proof
    regression_proof:
      rules:
        - globs:
            - "**/*.spec.ts"
          command: "pnpm exec jest {{files}}"
  - id: merge
    merge: {}
`;

const TWO_RULE_WORKFLOW_YAML = `name: issue-to-merge
nodes:
  - id: implement
    agent:
      prompt_file: prompts/implement.md
  - id: proof
    regression_proof:
      rules:
        - globs:
            - "apps/api/**/*.spec.ts"
          command: "pnpm exec jest {{files}}"
        - globs:
            - "apps/web/**/*.spec.ts"
          command: "pnpm exec ng test --include {{files}}"
  - id: merge
    merge: {}
`;

function makeFakeDeps(
  runCommand: VerifyFlowSetupDeps['runCommand'],
  trackedFiles: string[] = ['src/math.spec.ts', 'src/db.integration.spec.ts'],
): Partial<VerifyFlowSetupDeps> {
  return {
    createTempWorktree: () => okAsync('/tmp/fake-clean-wt'),
    removeTempWorktree: () => okAsync(undefined),
    listTrackedFiles: async () => trackedFiles,
    readPostCreate: () => [],
    writeCanaryFile: () => {},
    runCommand,
  };
}

function makeBaseRequest(overrides: Partial<VerifyFlowSetupRequest> = {}): VerifyFlowSetupRequest {
  return {
    baseSha: 'deadbeef',
    workflowYaml: SAMPLE_WORKFLOW_YAML,
    rules: [{ globs: ['**/*.spec.ts'], command: 'pnpm exec jest {{files}}' }],
    canaries: [
      {
        ruleIndex: 0,
        passingPath: 'src/__canary_pass__.spec.ts',
        failingPath: 'src/__canary_fail__.spec.ts',
        passingContent: 'test("pass", () => expect(1).toBe(1));',
        failingContent: 'test("fail", () => expect(1).toBe(2));',
      },
    ],
    infraFiles: ['src/db.integration.spec.ts'],
    ...overrides,
  };
}

describe('runFlowSetupVerification (fake executor)', () => {
  test('accepts a rule when passing canary, failing canary, existing test, and two-file run all succeed', async () => {
    const commands: string[] = [];
    const deps = makeFakeDeps(async (command): Promise<RunOutcome> => {
      commands.push(command);
      if (command.includes('__canary_fail__')) {
        return {
          kind: 'exited',
          exitCode: 1,
          output: 'FAIL src/__canary_fail__.spec.ts\nExpected: 2\nReceived: 1',
        };
      }
      if (command.includes('__canary_pass__') && command.includes('math.spec.ts')) {
        return {
          kind: 'exited',
          exitCode: 0,
          output: 'PASS src/__canary_pass__.spec.ts\nPASS src/math.spec.ts',
        };
      }
      if (command.includes('__canary_pass__')) {
        return { kind: 'exited', exitCode: 0, output: 'PASS src/__canary_pass__.spec.ts' };
      }
      if (command.includes('math.spec.ts')) {
        return { kind: 'exited', exitCode: 0, output: 'PASS src/math.spec.ts' };
      }
      return { kind: 'exited', exitCode: 1, output: 'unexpected command' };
    });

    const result = await runFlowSetupVerification(
      '/repo',
      makeBaseRequest(),
      new AbortController().signal,
      deps,
    );

    expect(result.ok).toBe(true);
    expect(result.acceptedCount).toBe(1);
    expect(result.rejectedCount).toBe(0);
    expect(result.verdicts[0]?.accepted).toBe(true);
    expect(result.verdicts[0]?.passingRun?.exitCode).toBe(0);
    expect(result.verdicts[0]?.failingRun?.exitCode).toBe(1);
    expect(result.verdicts[0]?.existingRun?.exitCode).toBe(0);
    expect(result.verdicts[0]?.twoFileRun?.exitCode).toBe(0);
    expect(result.prunedYaml).toContain('pnpm exec jest {{files}}');
    expect(commands).toHaveLength(4);
  });

  test('rejects a rule whose failing canary is inconclusive (e.g. module resolution error)', async () => {
    const deps = makeFakeDeps(async (command): Promise<RunOutcome> => {
      if (command.includes('__canary_pass__')) {
        return { kind: 'exited', exitCode: 0, output: 'PASS src/__canary_pass__.spec.ts' };
      }
      if (command.includes('__canary_fail__')) {
        return {
          kind: 'exited',
          exitCode: 1,
          output: "FAIL src/__canary_fail__.spec.ts\nError: Cannot find module './missing'",
        };
      }
      return { kind: 'exited', exitCode: 0, output: '' };
    });

    const result = await runFlowSetupVerification(
      '/repo',
      makeBaseRequest(),
      new AbortController().signal,
      deps,
    );

    expect(result.ok).toBe(false);
    expect(result.failureReason).toBe('no-rules-survived');
    expect(result.verdicts[0]?.accepted).toBe(false);
    expect(result.verdicts[0]?.reason).toMatch(/inconclusive/i);
    expect(result.prunedYaml).toBeNull();
  });

  test('rejects a command that ignores the files (output does not name the canary)', async () => {
    const deps = makeFakeDeps(async (): Promise<RunOutcome> => ({
      kind: 'exited',
      exitCode: 0,
      output: 'Ran 42 tests in unrelated-suite.spec.ts — all passed',
    }));

    const result = await runFlowSetupVerification(
      '/repo',
      makeBaseRequest(),
      new AbortController().signal,
      deps,
    );

    expect(result.ok).toBe(false);
    expect(result.failureReason).toBe('no-rules-survived');
    expect(result.verdicts[0]?.accepted).toBe(false);
    expect(result.verdicts[0]?.reason).toMatch(/did not name the passing canary/i);
  });

  test('rejects a command that fails or drops the second file on a two-file run', async () => {
    const deps = makeFakeDeps(async (command): Promise<RunOutcome> => {
      if (command.includes('__canary_fail__')) {
        return {
          kind: 'exited',
          exitCode: 1,
          output: 'FAIL src/__canary_fail__.spec.ts\nAssertionError: 1 !== 2',
        };
      }
      if (command.includes('__canary_pass__') && command.includes('math.spec.ts')) {
        // Simulates a runner that silently drops the second file.
        return {
          kind: 'exited',
          exitCode: 0,
          output: 'PASS src/__canary_pass__.spec.ts',
        };
      }
      if (command.includes('__canary_pass__')) {
        return { kind: 'exited', exitCode: 0, output: 'PASS src/__canary_pass__.spec.ts' };
      }
      return { kind: 'exited', exitCode: 0, output: 'PASS src/math.spec.ts' };
    });

    const result = await runFlowSetupVerification(
      '/repo',
      makeBaseRequest(),
      new AbortController().signal,
      deps,
    );

    expect(result.ok).toBe(false);
    expect(result.verdicts[0]?.accepted).toBe(false);
    expect(result.verdicts[0]?.reason).toMatch(/did not name both files/i);
  });

  test('rejects when existing repository tests fail to load (tries up to 3 candidates)', async () => {
    let existingCalls = 0;
    const deps = makeFakeDeps(
      async (command): Promise<RunOutcome> => {
        if (command.includes('__canary_pass__')) {
          return { kind: 'exited', exitCode: 0, output: 'PASS src/__canary_pass__.spec.ts' };
        }
        if (command.includes('__canary_fail__')) {
          return {
            kind: 'exited',
            exitCode: 1,
            output: 'FAIL src/__canary_fail__.spec.ts\nExpected: 2',
          };
        }
        existingCalls++;
        return { kind: 'exited', exitCode: 1, output: 'Cannot resolve alias @app/foo' };
      },
      ['src/a.spec.ts', 'src/b.spec.ts', 'src/c.spec.ts', 'src/d.spec.ts'],
    );

    const result = await runFlowSetupVerification(
      '/repo',
      makeBaseRequest(),
      new AbortController().signal,
      deps,
    );

    expect(existingCalls).toBe(3);
    expect(result.ok).toBe(false);
    expect(result.verdicts[0]?.accepted).toBe(false);
    expect(result.verdicts[0]?.reason).toMatch(/None of the 3 matched existing test file/i);
  });

  test('rejects when no existing non-infrastructure test file matches the rule globs', async () => {
    const deps = makeFakeDeps(
      async (command): Promise<RunOutcome> => {
        if (command.includes('__canary_pass__')) {
          return { kind: 'exited', exitCode: 0, output: 'PASS src/__canary_pass__.spec.ts' };
        }
        return {
          kind: 'exited',
          exitCode: 1,
          output: 'FAIL src/__canary_fail__.spec.ts\nExpected: 2',
        };
      },
      // Only an infra file exists, which is excluded.
      ['src/db.integration.spec.ts'],
    );

    const result = await runFlowSetupVerification(
      '/repo',
      makeBaseRequest(),
      new AbortController().signal,
      deps,
    );

    expect(result.ok).toBe(false);
    expect(result.verdicts[0]?.accepted).toBe(false);
    expect(result.verdicts[0]?.reason).toMatch(/No existing non-infrastructure test file matched/i);
  });

  test('prunes rejected rules and keeps accepted rules in prunedYaml', async () => {
    const exited = (exitCode: number, output: string): RunOutcome => ({
      kind: 'exited',
      exitCode,
      output,
    });
    // The first case whose words are all in the command answers it (order matters).
    const answers: Array<[string[], RunOutcome]> = [
      [['ng test', 'web_pass', 'web.spec.ts'], exited(1, 'Unknown option: apps/web/web.spec.ts')],
      [['ng test', 'web_fail'], exited(1, 'FAIL apps/web/web_fail.spec.ts')],
      [['ng test', 'web_pass'], exited(0, 'PASS apps/web/web_pass.spec.ts')],
      [['ng test'], exited(0, 'PASS apps/web/web.spec.ts')],
      [['api_fail'], exited(1, 'FAIL apps/api/api_fail.spec.ts')],
      [
        ['api_pass', 'api.spec.ts'],
        exited(0, 'PASS apps/api/api_pass.spec.ts\nPASS apps/api/api.spec.ts'),
      ],
      [['api_pass'], exited(0, 'PASS apps/api/api_pass.spec.ts')],
    ];
    const deps = makeFakeDeps(
      async (command): Promise<RunOutcome> =>
        answers.find(([words]) => words.every((w) => command.includes(w)))?.[1] ??
        exited(0, 'PASS apps/api/api.spec.ts'),
      ['apps/api/api.spec.ts', 'apps/web/web.spec.ts'],
    );

    const result = await runFlowSetupVerification(
      '/repo',
      makeBaseRequest({
        workflowYaml: TWO_RULE_WORKFLOW_YAML,
        rules: [
          { globs: ['apps/api/**/*.spec.ts'], command: 'pnpm exec jest {{files}}' },
          { globs: ['apps/web/**/*.spec.ts'], command: 'pnpm exec ng test --include {{files}}' },
        ],
        canaries: [
          {
            ruleIndex: 0,
            passingPath: 'apps/api/api_pass.spec.ts',
            failingPath: 'apps/api/api_fail.spec.ts',
            passingContent: 'ok',
            failingContent: 'fail',
          },
          {
            ruleIndex: 1,
            passingPath: 'apps/web/web_pass.spec.ts',
            failingPath: 'apps/web/web_fail.spec.ts',
            passingContent: 'ok',
            failingContent: 'fail',
          },
        ],
      }),
      new AbortController().signal,
      deps,
    );

    expect(result.ok).toBe(true);
    expect(result.acceptedCount).toBe(1);
    expect(result.rejectedCount).toBe(1);
    expect(result.verdicts[0]?.accepted).toBe(true);
    expect(result.verdicts[1]?.accepted).toBe(false);
    expect(result.prunedYaml).toContain('apps/api/**/*.spec.ts');
    expect(result.prunedYaml).not.toContain('apps/web/**/*.spec.ts');
  });

  test('fails with timed-out when a command exceeds the time budget', async () => {
    const deps = makeFakeDeps(async (): Promise<RunOutcome> => ({
      kind: 'timed-out',
      output: 'command timed out',
    }));

    const result = await runFlowSetupVerification(
      '/repo',
      makeBaseRequest({ timeoutMs: 100 }),
      new AbortController().signal,
      deps,
    );

    expect(result.ok).toBe(false);
    expect(result.failureReason).toBe('timed-out');
    expect(result.prunedYaml).toBeNull();
  });
});

describe('runFlowSetupVerification (real git isolation)', () => {
  test("does not include the agent's non-canary edits from the agent worktree", async () => {
    const root = mkdtempSync(join(tmpdir(), 'funny-setup-verify-git-'));
    try {
      const repoDir = join(root, 'repo');
      mkdirSync(join(repoDir, 'src'), { recursive: true });
      execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });

      // Base commit has a config file WITHOUT the agent's secret flag, plus an existing test.
      writeFileSync(join(repoDir, 'runner.config.json'), JSON.stringify({ allowCanary: false }));
      writeFileSync(join(repoDir, 'src/existing.spec.ts'), 'export const ok = true;\n');
      execFileSync('git', ['add', '.'], { cwd: repoDir });
      execFileSync('git', ['commit', '-m', 'base'], { cwd: repoDir });
      const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoDir,
        encoding: 'utf8',
      }).trim();

      // Create an agent worktree where the agent edits runner.config.json AND adds canaries.
      const agentWt = join(root, 'agent-wt');
      execFileSync('git', ['worktree', 'add', '-b', 'funny/factory-setup/1', agentWt, baseSha], {
        cwd: repoDir,
      });
      writeFileSync(join(agentWt, 'runner.config.json'), JSON.stringify({ allowCanary: true }));
      writeFileSync(join(agentWt, 'src/pass.spec.ts'), '// pass\n');
      writeFileSync(join(agentWt, 'src/fail.spec.ts'), '// fail\n');

      // Command only succeeds if runner.config.json has allowCanary: true (the agent's edit).
      const checkCmd = `node -e 'const cfg=require("./runner.config.json"); if(!cfg.allowCanary){console.error("missing agent config edit"); process.exit(1);} console.log(process.argv.slice(1).join(" "));' {{files}}`;

      const result = await runFlowSetupVerification(
        repoDir,
        {
          baseSha,
          workflowYaml: SAMPLE_WORKFLOW_YAML,
          rules: [{ globs: ['**/*.spec.ts'], command: checkCmd }],
          canaries: [
            {
              ruleIndex: 0,
              passingPath: 'src/pass.spec.ts',
              failingPath: 'src/fail.spec.ts',
            },
          ],
          agentWorktreePath: agentWt,
        },
        new AbortController().signal,
      );

      expect(result.ok).toBe(false);
      expect(result.verdicts[0]?.accepted).toBe(false);
      expect(result.verdicts[0]?.passingRun?.outputTail).toContain('missing agent config edit');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
