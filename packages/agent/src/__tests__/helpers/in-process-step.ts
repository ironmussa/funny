/**
 * The step runner, run in the test's process instead of as a child, with
 * the real `implement` step and a fake agent. While it runs, `process.env` is
 * exactly the environment the orchestrator gave the step, so the step's git
 * commands see what they would see in the child process (and nothing of the
 * test's own environment).
 *
 * Pull requests are opened the way `gh` would: with `GH_TOKEN` if the
 * environment has one, else the token in the gh config directory it points to.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import type { PullRequestOpener } from '../../ports/pull-requests.js';
import type { StepLauncher } from '../../ports/workspaces.js';
import { fixStepSpecSchema, runFixStep } from '../../steps/fix.js';
import { implementStepSpecSchema, runImplementStep } from '../../steps/implement.js';
import type { FakeGithubApi } from './fake-github-api.js';
import { fakeAgents, type FakeAgentTurn } from './step-fakes.js';

/** The token `gh` would use with `env`. */
export function ghToken(env: Record<string, string | undefined>): string | null {
  if (env.GH_TOKEN) return env.GH_TOKEN;
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  const dir =
    env.GH_CONFIG_DIR ??
    join(env.XDG_CONFIG_HOME ?? join(env.HOME ?? '/nonexistent', '.config'), 'gh');
  try {
    const hosts = readFileSync(join(dir, 'hosts.yml'), 'utf8');
    return /^\s{4}oauth_token: (\S+)$/m.exec(hosts)?.[1] ?? null;
  } catch {
    return null;
  }
}

function ghLikeOpener(
  github: FakeGithubApi,
  repo: string,
  env: Record<string, string>,
): PullRequestOpener {
  return {
    async openDraft(pr) {
      const token = ghToken(env);
      if (!token) return { ok: false, error: 'gh: not logged in' };
      const res = await github.fetch(`${github.api}/repos/${repo}/pulls`, {
        method: 'POST',
        headers: { authorization: `token ${token}` },
        body: JSON.stringify({
          title: pr.title,
          body: pr.body,
          head: pr.head,
          base: pr.base,
          draft: true,
        }),
      });
      if (!res.ok) return { ok: false, error: `gh: HTTP ${res.status}` };
      const body = (await res.json()) as { html_url: string };
      return { ok: true, url: body.html_url };
    },
  };
}

/** Swap `process.env` for `env` while `fn` runs. */
async function withProcessEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

export function inProcessStepLauncher(options: {
  github: FakeGithubApi;
  repo: string;
  /** The agent's turns for one step; `ghConfigDir` is where the run's token lives. */
  turns: (run: { ghConfigDir: string; step: 'implement' | 'fix' }) => FakeAgentTurn[];
}): StepLauncher {
  return async ({ step, specPath, cwd, env }) => {
    const raw = JSON.parse(readFileSync(specPath, 'utf8'));
    const agents = fakeAgents(options.turns({ ghConfigDir: env.GH_CONFIG_DIR, step }));
    if (step === 'fix') {
      const outcome = await withProcessEnv(env, () =>
        runFixStep(fixStepSpecSchema.parse(raw), { cwd, agents, print: () => {} }),
      );
      return outcome.kind === 'pushed' ? 0 : 1;
    }
    const outcome = await withProcessEnv(env, () =>
      runImplementStep(implementStepSpecSchema.parse(raw), {
        cwd,
        agents,
        pullRequests: ghLikeOpener(options.github, options.repo, env),
        print: () => {},
      }),
    );
    return outcome.kind === 'pr_opened' ? 0 : 1;
  };
}
