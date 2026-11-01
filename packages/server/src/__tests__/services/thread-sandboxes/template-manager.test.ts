import { describe, expect, test } from 'bun:test';

import { createFakeSandboxProvider } from '../../../services/thread-sandboxes/providers/fake/fake-provider.js';
import { resolveRunnerBuild } from '../../../services/thread-sandboxes/runner-build.js';
import {
  INSTALLED_COMMIT_FILE,
  RUNNER_INSTALL_SCRIPT,
  runnerInstallCommand,
  SANDBOX_ENV_FILE,
  startRunnerCommand,
} from '../../../services/thread-sandboxes/runner-install-script.js';
import { createRunnerTemplateManager } from '../../../services/thread-sandboxes/template-manager.js';
import { expectOk } from './provider-contract.js';

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
});

describe('runner install script', () => {
  test('installs the exact commit as a service gated on the sandbox env file', () => {
    expect(RUNNER_INSTALL_SCRIPT).toContain('git fetch -q --depth 1 origin "$FUNNY_COMMIT"');
    expect(RUNNER_INSTALL_SCRIPT).toContain(`ConditionPathExists=$ENV_FILE`);
    expect(RUNNER_INSTALL_SCRIPT).toContain(INSTALLED_COMMIT_FILE);
    const command = runnerInstallCommand(build);
    expect(command).toContain(`FUNNY_COMMIT='${SHA}'`);
    expect(command).toContain("FUNNY_REPO_URL='https://github.com/ironmussa/funny.git'");
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
});
