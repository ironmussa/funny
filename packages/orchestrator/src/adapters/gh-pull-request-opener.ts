/**
 * PullRequestOpener over the `gh` CLI, run inside the workspace.
 *
 * `gh` authenticates with whatever the workspace was given (the run's Factory
 * App token in its `gh` config); this adapter passes no credential itself.
 */

import { execute } from '@funny/core/git';

import type {
  DraftPullRequest,
  OpenPullRequestResult,
  PullRequestOpener,
} from '../ports/pull-requests.js';

export class GhPullRequestOpener implements PullRequestOpener {
  async openDraft(pr: DraftPullRequest): Promise<OpenPullRequestResult> {
    const args = ['pr', 'create', '--draft', '--base', pr.base, '--head', pr.head];
    args.push('--title', pr.title, '--body', pr.body);
    return execute('gh', args, { cwd: pr.cwd, reject: false }).then(toResult, (err: Error) => ({
      ok: false as const,
      error: `gh could not run: ${err.message}`,
    }));
  }
}

/** `gh pr create` prints the new pull request's URL as its last line. */
function toResult(run: {
  stdout: string;
  stderr: string;
  exitCode: number;
}): OpenPullRequestResult {
  const url = run.stdout.trim().split('\n').pop() ?? '';
  if (run.exitCode === 0 && url) return { ok: true, url };
  return {
    ok: false,
    error: (run.stderr || run.stdout).trim() || `gh exited with ${run.exitCode}`,
  };
}
