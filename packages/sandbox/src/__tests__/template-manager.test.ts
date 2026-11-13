import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFakeSandboxProvider } from '../providers/fake/fake-provider.js';
import { resolveRunnerBuild, resolveServerRunnerBuild, sameRepository } from '../runner-build.js';
import {
  INSTALLED_COMMIT_FILE,
  RUNNER_INSTALL_SCRIPT,
  runnerInstallCommand,
  SANDBOX_ENV_FILE,
  startRunnerCommand,
} from '../runner-install-script.js';
import { createRunnerTemplateManager } from '../template-manager.js';
import { expectOk } from '../testing/provider-contract.js';

const SHA = 'a'.repeat(40);
const build = expectOk(resolveRunnerBuild({ FUNNY_BUILD_COMMIT: SHA }));

describe('resolveRunnerBuild', () => {
  test('uses FUNNY_BUILD_COMMIT, then RAILWAY_GIT_COMMIT_SHA, and the public repo by default', () => {
    expect(build).toEqual({
      commit: SHA,
      version: SHA.slice(0, 12),
      repoUrl: 'https://github.com/ironmussa/funny.git',
    });
    const railway = expectOk(resolveRunnerBuild({ RAILWAY_GIT_COMMIT_SHA: 'B'.repeat(40) }));
    expect(railway.commit).toBe('b'.repeat(40));
  });

  test('refuses a missing or short commit', () => {
    expect(resolveRunnerBuild({}).isErr()).toBe(true);
    expect(resolveRunnerBuild({ FUNNY_BUILD_COMMIT: 'abc123' }).isErr()).toBe(true);
  });

  test('falls back to the pushed HEAD of the local checkout', () => {
    const local = expectOk(resolveRunnerBuild({}, { commit: 'D'.repeat(40), pushed: true }));
    expect(local.commit).toBe('d'.repeat(40));
  });

  test('refuses an unpushed local HEAD with a push hint', () => {
    const result = resolveRunnerBuild({}, { commit: 'e'.repeat(40), pushed: false });
    expect(result.isErr() && result.error.kind).toBe('build-commit-not-pushed');
  });

  test('prefers the configured commit over the local checkout', () => {
    const configured = expectOk(
      resolveRunnerBuild({ FUNNY_BUILD_COMMIT: SHA }, { commit: 'e'.repeat(40), pushed: false }),
    );
    expect(configured.commit).toBe(SHA);
  });

  test('compares repositories across https, ssh and scp-like URLs', () => {
    const funny = 'https://github.com/ironmussa/funny.git';
    for (const same of [
      'git@github.com:ironmussa/funny.git',
      'ssh://git@github.com:22/ironmussa/funny',
      'https://x-access-token:abc@github.com/IronMussa/funny/',
    ]) {
      expect(sameRepository(same, funny)).toBe(true);
    }
    expect(sameRepository('git@github.com:someone/funny.git', funny)).toBe(false);
    expect(sameRepository('https://gitlab.com/ironmussa/funny.git', funny)).toBe(false);
  });

  describe('local checkout fallback', () => {
    /** A repo whose HEAD is "pushed" to `remoteUrl` (a remote-tracking ref holds it). */
    function checkout(remoteUrl: string) {
      const dir = mkdtempSync(join(tmpdir(), 'funny-runner-build-'));
      // Hook-inherited GIT_* vars would point git at the funny repository.
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
      );
      const git = (...args: string[]) => {
        const run = Bun.spawnSync(['git', ...args], { cwd: dir, env });
        if (run.exitCode !== 0) throw new Error(run.stderr.toString());
        return run.stdout.toString().trim();
      };
      git('init', '-q');
      git(
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'x',
      );
      git('remote', 'add', 'origin', remoteUrl);
      git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      return { dir, head: git('rev-parse', 'HEAD') };
    }

    async function buildIn(dir: string) {
      const saved = { ...process.env };
      const cwd = process.cwd();
      for (const key of Object.keys(process.env))
        if (key.startsWith('GIT_')) delete process.env[key];
      delete process.env.FUNNY_BUILD_COMMIT;
      delete process.env.RAILWAY_GIT_COMMIT_SHA;
      delete process.env.FUNNY_REPO_URL;
      process.chdir(dir);
      try {
        return await resolveServerRunnerBuild();
      } finally {
        process.chdir(cwd);
        Object.assign(process.env, saved);
        rmSync(dir, { recursive: true, force: true });
      }
    }

    test('uses the pushed HEAD of a checkout of the funny repository', async () => {
      const { dir, head } = checkout('git@github.com:ironmussa/funny.git');
      expect(expectOk(await buildIn(dir)).commit).toBe(head);
    });

    test('ignores the checkout of another repository, even when pushed', async () => {
      const { dir } = checkout('https://github.com/someone/other-project.git');
      const result = await buildIn(dir);
      expect(result.isErr() && result.error.kind).toBe('missing-build-commit');
    });
  });
});

describe('runner install script', () => {
  test('installs the exact commit as a service gated on the sandbox env file', () => {
    expect(RUNNER_INSTALL_SCRIPT).toContain('git fetch -q --depth 1 origin "$FUNNY_COMMIT"');
    expect(RUNNER_INSTALL_SCRIPT).toContain(`ConditionPathExists=$ENV_FILE`);
    expect(RUNNER_INSTALL_SCRIPT).toContain(INSTALLED_COMMIT_FILE);
    const command = runnerInstallCommand(build);
    expect(command).toContain(`FUNNY_COMMIT='${SHA}'`);
    expect(command).toContain("FUNNY_REPO_URL='https://github.com/ironmussa/funny.git'");
    // Compiling native-git takes minutes: only template builds do it.
    expect(command).not.toContain("FUNNY_BUILD_NATIVE='1'");
  });

  test('the env command writes only safe values and restarts the runner', () => {
    const command = expectOk(
      startRunnerCommand({
        TEAM_SERVER_URL: 'https://funny.example',
        RUNNER_PROVISION_TOKEN: 'rprov_Ab-9_x',
      }),
    );
    expect(command).toContain(SANDBOX_ENV_FILE);
    expect(command).toContain('RUNNER_PROVISION_TOKEN=rprov_Ab-9_x');
    expect(command).toContain('systemctl restart funny-runner.service');
    expect(startRunnerCommand({ TEAM_SERVER_URL: 'x"; rm -rf /' }).isErr()).toBe(true);
    expect(startRunnerCommand({ 'bad-key': 'v' }).isErr()).toBe(true);
  });
});

describe('runner template manager', () => {
  const freshProvider = (templates: string[] = []) =>
    createFakeSandboxProvider('fake-valid', { templates });

  test('builds the missing template once for concurrent callers', async () => {
    const provider = freshProvider();
    const manager = createRunnerTemplateManager(build);
    expect(expectOk(await manager.current(provider))).toBeNull();

    const [a, b] = await Promise.all([
      manager.ensure('conn-1', provider),
      manager.ensure('conn-1', provider),
    ]);
    expect(expectOk(a).ref).toBe(`funny-runner-${build.version}`);
    expect(expectOk(b).ref).toBe(expectOk(a).ref);
    expect(provider.templateBuilds).toHaveLength(1);
    expect(provider.templateBuilds[0].scriptEnv).toEqual({
      FUNNY_REPO_URL: build.repoUrl,
      FUNNY_COMMIT: SHA,
      FUNNY_BUILD_NATIVE: '1',
    });
    expect(manager.isBuilding('conn-1')).toBe(false);
  });

  test('reuses a ready template without building', async () => {
    const provider = freshProvider([build.version]);
    const manager = createRunnerTemplateManager(build);
    expectOk(await manager.ensure('conn-1', provider));
    expect(provider.templateBuilds).toHaveLength(0);
  });

  test('deletes templates of older builds after building the new one', async () => {
    const provider = freshProvider(['old-version-1', 'old-version-2']);
    const manager = createRunnerTemplateManager(build);
    expectOk(await manager.ensure('conn-1', provider));
    const remaining = expectOk(await provider.listTemplates!()).map((t) => t.ref);
    expect(remaining).toEqual([`funny-runner-${build.version}`]);
  });

  test('a failed build is reported and a later call retries', async () => {
    const provider = freshProvider();
    const manager = createRunnerTemplateManager(build);
    provider.failNext({ kind: 'unavailable', message: 'boat down' });
    const first = await manager.ensure('conn-1', provider);
    expect(first.isErr() && first.error.kind).toBe('unavailable');
    expectOk(await manager.ensure('conn-1', provider));
  });

  test('an account that cannot hold templates is not retried for a while', async () => {
    const provider = freshProvider();
    const manager = createRunnerTemplateManager(build);
    provider.failNext({ kind: 'unsupported', message: 'trial plan' });
    const first = await manager.ensure('conn-trial', provider);
    expect(first.isErr() && first.error.kind).toBe('unsupported');
    const second = await manager.ensure('conn-trial', provider);
    expect(second.isErr() && second.error.kind).toBe('unsupported');
    expect(provider.templateBuilds).toHaveLength(0);
  });

  test('reports through the logger and metric sink it is given', async () => {
    const logs: Array<{ level: string; message: string }> = [];
    const metrics: Array<{ name: string; attributes?: Record<string, string> }> = [];
    const manager = createRunnerTemplateManager(build, {
      log: {
        info: (message) => logs.push({ level: 'info', message }),
        warn: (message) => logs.push({ level: 'warn', message }),
      },
      metric: (name, _value, options) => metrics.push({ name, attributes: options?.attributes }),
    });
    expectOk(await manager.ensure('conn-1', freshProvider()));
    expect(logs).toEqual([{ level: 'info', message: 'Building runner template' }]);
    expect(metrics).toEqual([
      { name: 'thread_sandboxes.template_build_ms', attributes: { provider: 'fake' } },
    ]);

    const trial = freshProvider();
    trial.failNext({ kind: 'unsupported', message: 'trial plan' });
    await manager.ensure('conn-trial', trial);
    expect(logs.at(-1)).toEqual({
      level: 'warn',
      message: 'Runner templates unavailable for this provider account',
    });
  });
});
