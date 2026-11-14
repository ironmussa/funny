/**
 * ActionProvider that runs a workflow's actions inside a factory run's
 * workspace: Claude Code agents through `@funny/core/agents`, commands and git
 * through `@funny/core/git`, pull requests through a PullRequestOpener.
 *
 * - Every agent action of one step resumes the same agent session, so a fix
 *   keeps the context of the implementation.
 * - The agent, commands and commits all use the configured commit author.
 * - Each failed action records whether it was the agent's failure (checks,
 *   no changes, the agent erroring) or the infrastructure's (git push,
 *   GitHub), which decides whether the run may be retried.
 */

import type { CLIMessage, IAgentProcessFactory } from '@funny/core/agents';
import { commit, executeShell, git } from '@funny/core/git';
import { internal } from '@funny/shared/errors';
import { resolveModelId } from '@funny/shared/models';
import type {
  ActionProvider,
  ActionResult,
  ApprovalDecision,
  CreatePrOpts,
  GitCommitOpts,
  GitPushOpts,
  RunCommandOpts,
  SpawnAgentOpts,
} from '@funny/workflows/compiler';
import { err, ok } from 'neverthrow';

import type { FailureKind } from '../domain/step-outcome.js';
import type { PullRequestOpener } from '../ports/pull-requests.js';
import { resolveBaseRef } from './base-ref.js';

/**
 * Errors of the agent CLI that are the infrastructure's, not the agent's: the
 * model provider overloaded or rate-limiting, a refused credential, the network.
 */
const INFRA_AGENT_ERRORS =
  /rate.?limit|overloaded|\b(401|403|429|500|502|503|529)\b|api key|authenticat|credit balance|ECONN|ETIMEDOUT|network/i;

/**
 * What the agent and the project's commands get over the step's environment:
 * no way to write to GitHub. Pushing and opening the pull request are the
 * factory's own steps, which keep the run's credentials. Git's credential
 * helpers are cleared (command-line config is read last, and an empty helper
 * drops the ones before it), `git push origin` goes to a URL no transport
 * serves, and `gh` has neither a login nor a token (in a sandbox, its wrapper
 * is turned off too). The base is fetched by the factory before the agent
 * needs it.
 */
const NO_GITHUB_WRITE_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_COUNT: '3',
  GIT_CONFIG_KEY_0: 'credential.helper',
  GIT_CONFIG_VALUE_0: '',
  GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
  GIT_CONFIG_VALUE_1: '',
  GIT_CONFIG_KEY_2: 'remote.origin.pushurl',
  GIT_CONFIG_VALUE_2: 'factory-only://the-issue-factory-pushes',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
  GH_CONFIG_DIR: '/nonexistent/funny-factory-agent-gh',
  GH_TOKEN: '',
  GITHUB_TOKEN: '',
  GH_ENTERPRISE_TOKEN: '',
  GITHUB_ENTERPRISE_TOKEN: '',
  FACTORY_GITHUB_TOKEN_FILE: '',
  FACTORY_REAL_GH: '',
};

/** Tools that wait for a person; nobody answers in an unattended run. */
const INTERACTIVE_TOOLS = ['AskUserQuestion', 'ExitPlanMode'];

/** How much of a failing command's output is handed to the agent. */
const MAX_FAILURE_OUTPUT = 8_000;

/** A check command that runs longer than this is treated as failing. */
const DEFAULT_COMMAND_TIMEOUT_MS = 60 * 60 * 1000;

export interface WorkspaceActionProviderOptions {
  cwd: string;
  branch: string;
  base: string;
  author: { name: string; email: string };
  model: string;
  agents: IAgentProcessFactory;
  pullRequests: PullRequestOpener;
  /** Receives every message of every agent action. */
  onAgentMessage: (message: CLIMessage) => void;
}

export class WorkspaceActionProvider implements ActionProvider {
  /** The agent session; set by the first agent action, resumed by the next. */
  sessionId: string | undefined;
  /** URL of the pull request this step opened. */
  prUrl: string | undefined;
  /** Kind of the most recent failed action. */
  lastFailure: FailureKind | undefined;

  constructor(private readonly options: WorkspaceActionProviderOptions) {}

  async spawnAgent(opts: SpawnAgentOpts): Promise<ActionResult> {
    const { agents, model, onAgentMessage } = this.options;
    const process = agents.create({
      provider: 'claude',
      prompt: opts.prompt,
      cwd: this.options.cwd,
      model: modelIdFor(opts.model ?? model),
      sessionId: this.sessionId,
      permissionMode: 'bypassPermissions',
      disallowedTools: [...INTERACTIVE_TOOLS, ...(opts.disallowedTools ?? [])],
      allowedTools: opts.allowedTools,
      env: this.untrustedEnv(),
    });

    // The agent erroring is the agent's failure; the process failing to run or
    // dying without a result is the infrastructure's.
    const { result, kind } = await new Promise<{ result: ActionResult; kind: FailureKind }>(
      (resolve) => {
        let settled = false;
        const settle = (value: ActionResult, failure: FailureKind = 'agent') => {
          if (settled) return;
          settled = true;
          resolve({ result: value, kind: failure });
        };
        process.on('message', (message) => {
          onAgentMessage(message);
          if ('session_id' in message && typeof message.session_id === 'string') {
            this.sessionId = message.session_id;
          }
          if (message.type === 'result') {
            const error = message.result || `agent ended with ${message.subtype}`;
            if (!message.is_error) settle({ ok: true, output: message.result ?? '' });
            else settle({ ok: false, error }, INFRA_AGENT_ERRORS.test(error) ? 'infra' : 'agent');
          }
        });
        process.on('error', (err) => settle({ ok: false, error: err.message }, 'infra'));
        process.on('exit', (code) =>
          settle({ ok: false, error: `agent exited (code ${code}) without a result` }, 'infra'),
        );
        try {
          process.start();
        } catch (err) {
          settle({ ok: false, error: err instanceof Error ? err.message : String(err) }, 'infra');
        }
      },
    );

    await process.kill().catch(() => undefined);
    return this.record(result, kind);
  }

  async runCommand(opts: RunCommandOpts): Promise<ActionResult> {
    let run: { stdout: string; stderr: string; exitCode: number };
    try {
      run = await executeShell(opts.command, {
        cwd: opts.cwd,
        timeout: opts.timeout ?? DEFAULT_COMMAND_TIMEOUT_MS,
        env: this.untrustedEnv(),
        reject: false,
      });
    } catch (err) {
      // Timed out or produced more output than can be held: the checks failed.
      const reason = err instanceof Error ? err.message : String(err);
      return this.record(
        { ok: false, error: `\`${opts.command}\` did not finish: ${reason}` },
        'agent',
      );
    }
    const { stdout, stderr, exitCode } = run;
    if (exitCode === 0) return this.record({ ok: true, output: stdout }, 'agent');
    const output = `${stdout}\n${stderr}`.trim();
    return this.record(
      {
        ok: false,
        error: `\`${opts.command}\` exited with ${exitCode}\n${output.slice(-MAX_FAILURE_OUTPUT)}`,
      },
      'agent',
    );
  }

  async gitCommit(opts: GitCommitOpts): Promise<ActionResult> {
    const { cwd, author } = this.options;
    const status = await git(['status', '--porcelain'], cwd);
    if (status.isErr()) return this.record({ ok: false, error: status.error.message }, 'infra');

    if (status.value.trim()) {
      const staged = await git(['add', '--all'], cwd);
      if (staged.isErr()) return this.record({ ok: false, error: staged.error.message }, 'infra');
      const committed = await commit(cwd, opts.message, { author }, opts.amend, opts.noVerify);
      // A failing commit is almost always a pre-commit hook: the agent's to fix.
      if (committed.isErr()) {
        return this.record({ ok: false, error: committed.error.message }, 'agent');
      }
    }

    const ahead = await this.commitsAheadOfBase();
    if (ahead.isErr()) return this.record({ ok: false, error: ahead.error.message }, 'infra');
    if (ahead.value === 0) {
      return this.record(
        { ok: false, error: `no changes: the branch has no commits ahead of ${this.options.base}` },
        'agent',
      );
    }
    return this.record(
      { ok: true, output: `${ahead.value} commit(s) ahead of ${this.options.base}` },
      'agent',
    );
  }

  async gitPush(opts: GitPushOpts): Promise<ActionResult> {
    const branch = opts.branch || this.options.branch;
    const args = ['push', ...(opts.setUpstream ? ['-u'] : []), 'origin', `HEAD:${branch}`];
    if (opts.force) args.splice(1, 0, '--force-with-lease');
    const pushed = await git(args, this.options.cwd);
    return this.record(
      pushed.isOk()
        ? { ok: true, output: pushed.value }
        : { ok: false, error: pushed.error.message },
      'infra',
    );
  }

  async createPr(opts: CreatePrOpts): Promise<ActionResult> {
    // The factory only ever opens drafts: they are marked ready once CI is green.
    const opened = await this.options.pullRequests.openDraft({
      cwd: this.options.cwd,
      title: opts.title,
      body: opts.body ?? '',
      base: opts.base || this.options.base,
      head: this.options.branch,
    });
    if (!opened.ok) return this.record({ ok: false, error: opened.error }, 'infra');
    this.prUrl = opened.url;
    return this.record({ ok: true, output: opened.url }, 'infra');
  }

  async notify(): Promise<ActionResult> {
    return { ok: true };
  }

  async setStatus(): Promise<ActionResult> {
    return { ok: true };
  }

  async setStage(): Promise<ActionResult> {
    return { ok: true };
  }

  async requestApproval(): Promise<ApprovalDecision> {
    return { decision: 'reject', reason: 'factory runs are unattended: nobody can approve' };
  }

  /** Remembers who is to blame when `result` failed; a success clears it. */
  private record(result: ActionResult, kind: FailureKind): ActionResult {
    this.lastFailure = result.ok ? undefined : kind;
    return result;
  }

  private commitsAheadOfBase() {
    const { cwd, base } = this.options;
    return resolveBaseRef(cwd, base)
      .andThen((baseRef) => git(['rev-list', '--count', `${baseRef}..HEAD`], cwd))
      .andThen((count) => {
        const ahead = Number.parseInt(count.trim(), 10);
        return Number.isNaN(ahead)
          ? err(internal(`unexpected \`git rev-list --count\` output: ${count}`))
          : ok(ahead);
      });
  }

  /** Commits made by the agent or by hooks carry the configured author too. */
  /** The agent's and the project commands' environment: the author, and no GitHub write access. */
  private untrustedEnv(): Record<string, string> {
    return { ...this.authorEnv(), ...NO_GITHUB_WRITE_ENV };
  }

  private authorEnv(): Record<string, string> {
    const { name, email } = this.options.author;
    return {
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
    };
  }
}

/** Friendly names (`sonnet`) map to model ids; full ids pass through. */
function modelIdFor(model: string): string {
  try {
    return resolveModelId('claude', model as Parameters<typeof resolveModelId>[1]);
  } catch {
    return model;
  }
}
