/**
 * Edge fakes for the step runner seam: a scripted agent and a GitHub that
 * records the pull requests it is asked to open.
 */

import { EventEmitter } from 'events';

import type { AgentProcessOptions, IAgentProcess, IAgentProcessFactory } from '@funny/core/agents';

import type { DraftPullRequest, PullRequestOpener } from '../../ports/pull-requests.js';

/**
 * One agent turn: may change files in `cwd`, returns the agent's final text.
 * Throwing makes the turn end as an agent error.
 */
export type FakeAgentTurn = (call: {
  cwd: string;
  prompt: string;
  sessionId?: string;
}) => string | Promise<string>;

export interface FakeAgents extends IAgentProcessFactory {
  /** Every agent start, in order. */
  readonly calls: AgentProcessOptions[];
}

/**
 * Plays `turns` in order, one per agent start. A start without a session to
 * resume gets a new session id (`session-1`, `session-2`, …). Once the turns
 * run out, further starts change nothing.
 */
export function fakeAgents(turns: FakeAgentTurn[]): FakeAgents {
  const calls: AgentProcessOptions[] = [];
  let sessions = 0;

  return {
    calls,
    create(options) {
      calls.push(options);
      const turn = turns[calls.length - 1] ?? (() => 'Nothing left to do.');
      const sessionId = options.sessionId ?? `session-${++sessions}`;
      return new FakeProcess(options, sessionId, turn);
    },
  };
}

class FakeProcess extends EventEmitter implements IAgentProcess {
  exited = false;

  constructor(
    private options: AgentProcessOptions,
    private sessionId: string,
    private turn: FakeAgentTurn,
  ) {
    super();
  }

  start(): void {
    void this.play();
  }

  async kill(): Promise<void> {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', 0);
  }

  private async play(): Promise<void> {
    await Promise.resolve();
    const session_id = this.sessionId;
    this.emit('message', {
      type: 'system',
      subtype: 'init',
      session_id,
      tools: ['Write'],
      model: this.options.model ?? 'sonnet',
      cwd: this.options.cwd,
    });
    let text: string;
    let isError = false;
    try {
      text = await this.turn({
        cwd: this.options.cwd,
        prompt: this.options.prompt,
        sessionId: this.options.sessionId,
      });
    } catch (err) {
      text = err instanceof Error ? err.message : String(err);
      isError = true;
    }
    this.emit('message', {
      type: 'assistant',
      message: {
        id: `msg-${session_id}`,
        content: [
          { type: 'tool_use', id: `tool-${session_id}`, name: 'Write', input: { file: 'x' } },
          { type: 'text', text },
        ],
      },
    });
    this.emit('message', {
      type: 'result',
      subtype: isError ? 'error_during_execution' : 'success',
      is_error: isError,
      result: text,
      session_id,
      duration_ms: 1,
      num_turns: 1,
      total_cost_usd: 0,
    });
  }
}

export interface FakeGitHub extends PullRequestOpener {
  readonly opened: (DraftPullRequest & { url: string })[];
}

/** Records draft pull requests; `fail` makes every open fail with that message. */
export function fakeGitHub(options: { fail?: string } = {}): FakeGitHub {
  const opened: (DraftPullRequest & { url: string })[] = [];
  return {
    opened,
    async openDraft(pr) {
      if (options.fail) return { ok: false, error: options.fail };
      const url = `https://github.com/acme/demo/pull/${opened.length + 1}`;
      opened.push({ ...pr, url });
      return { ok: true, url };
    },
  };
}
