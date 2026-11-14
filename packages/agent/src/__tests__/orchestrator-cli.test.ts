/**
 * The orchestrator's `start` and `status` commands, seen from outside: the
 * exit code, what they print, and what ends up in the state store. The
 * configuration file, the environment, the TTY prompt and the factory home
 * are real or injected at the edge; nothing internal is asserted.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';

import { openRunStore } from '../adapters/sqlite-run-store.js';
import { runOrchestratorCli, type OrchestratorIo } from '../cli.js';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const MODEL_KEY = 'sk-ant-api03-factory-model-key-0123456789';
const SANDBOX_KEY = 'boat_live_sandbox_credential_9876543210';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'funny-factory-cli-'));
  dirs.push(root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(project);
  const configPath = join(root, 'factory.yaml');
  return { root, home, project, configPath };
}

function configYaml(project: string, extra = ''): string {
  return `github:
  login: octo-owner
  author:
    name: Octo Owner
    email: octo@example.com
model: sonnet
sandbox:
  provider: boat
projects:
  - path: ${project}
    repo: acme/app
  - path: ${project}
    repo: acme/tools
    workspace: worktree
    base: develop
    check: bun run lint
${extra}`;
}

const fullEnv = (): Record<string, string | undefined> => ({
  FUNNY_FACTORY_MODEL_KEY: MODEL_KEY,
  FUNNY_FACTORY_APP_ID: '5690396',
  FUNNY_FACTORY_APP_PRIVATE_KEY: privateKey.replace(/\n/g, '\\n'),
  FUNNY_FACTORY_SANDBOX_CREDENTIAL: SANDBOX_KEY,
});

async function run(
  argv: string[],
  ctx: { home: string },
  io: Partial<OrchestratorIo> = {},
): Promise<{ code: number; out: string; err: string; prompted: string[] }> {
  let out = '';
  let err = '';
  const prompted: string[] = [];
  const code = await runOrchestratorCli(argv, {
    env: Object.assign(io.env ?? {}, { FUNNY_FACTORY_HOME: ctx.home }),
    stdout: (text) => void (out += text),
    stderr: (text) => void (err += text),
    isTTY: io.isTTY ?? false,
    prompt:
      io.prompt ??
      (async (question) => {
        prompted.push(question);
        return null;
      }),
    untilStopped: io.untilStopped ?? (() => Promise.resolve()),
  });
  return { code, out, err, prompted };
}

describe('orchestrator start', () => {
  test('starts with a valid file and every secret from the environment', async () => {
    const ctx = setup();
    writeFileSync(ctx.configPath, configYaml(ctx.project));
    const result = await run(['start', '--config', ctx.configPath], ctx, { env: fullEnv() });
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    expect(result.out).toContain('Issue factory started');
    expect(result.out).toContain('acme/app (sandbox)');
    expect(result.out).toContain('acme/tools (worktree)');
    expect(result.out).toContain('Issue factory stopped');
  });

  test("a project path starting with ~ is in the user's home", async () => {
    const ctx = setup();
    const inHome = mkdtempSync(join(homedir(), '.funny-factory-cli-'));
    dirs.push(inHome);
    const relative = `~/${inHome.slice(homedir().length + 1)}`;
    writeFileSync(
      ctx.configPath,
      configYaml(ctx.project).replaceAll(`path: ${ctx.project}`, `path: ${relative}`),
    );
    const result = await run(['start', '--config', ctx.configPath], ctx, { env: fullEnv() });
    expect(result.err).toBe('');
    expect(result.out).toContain(`path=${inHome}`);
  });

  test('defaults the config file to the factory home', async () => {
    const ctx = setup();
    mkdirSync(ctx.home, { recursive: true });
    writeFileSync(join(ctx.home, 'config.yaml'), configYaml(ctx.project));
    expect((await run(['start'], ctx, { env: fullEnv() })).code).toBe(0);
  });

  test('an invalid file exits and names the wrong field', async () => {
    const ctx = setup();
    const cases: Array<[string, string]> = [
      [configYaml(ctx.project).replace('repo: acme/app', 'repo: not-a-repo'), 'projects.0.repo'],
      [configYaml(ctx.project).replace('model: sonnet', 'model: 7'), 'model'],
      [configYaml(ctx.project, 'limits:\n  concurrency: 0\n'), 'limits.concurrency'],
      [configYaml(ctx.project, 'colour: blue\n'), 'colour'],
      [configYaml(ctx.project).replace('provider: boat', 'provider: nowhere'), 'sandbox.provider'],
      [configYaml(join(ctx.root, 'missing')), 'projects.0.path'],
    ];
    for (const [yaml, field] of cases) {
      writeFileSync(ctx.configPath, yaml);
      const result = await run(['start', '--config', ctx.configPath], ctx, { env: fullEnv() });
      expect(result.code).toBe(1);
      expect(result.err).toContain(field);
      expect(result.out).not.toContain('Issue factory started');
    }
  });

  test('a sandbox project needs a sandbox provider', async () => {
    const ctx = setup();
    writeFileSync(
      ctx.configPath,
      configYaml(ctx.project).replace(/sandbox:\n {2}provider: boat\n/, ''),
    );
    const result = await run(['start', '--config', ctx.configPath], ctx, { env: fullEnv() });
    expect(result.code).toBe(1);
    expect(result.err).toContain('sandbox');
  });

  test('a missing or unreadable file is refused', async () => {
    const ctx = setup();
    const missing = await run(['start', '--config', ctx.configPath], ctx, { env: fullEnv() });
    expect(missing.code).toBe(1);
    expect(missing.err).toContain(ctx.configPath);
    writeFileSync(ctx.configPath, 'projects: [unclosed');
    expect((await run(['start', '--config', ctx.configPath], ctx, { env: fullEnv() })).code).toBe(
      1,
    );
  });

  test('a key or a value that looks like a secret is refused, without echoing it', async () => {
    const ctx = setup();
    for (const [extra, field] of [
      ['api_key: hello\n', 'api_key'],
      ['github_token: hello\n', 'github_token'],
      ['notes:\n  private_key: hello\n', 'notes.private_key'],
    ]) {
      writeFileSync(ctx.configPath, configYaml(ctx.project, extra));
      const result = await run(['start', '--config', ctx.configPath], ctx, { env: fullEnv() });
      expect(result.code).toBe(1);
      expect(result.err).toContain(field);
      expect(result.err).toContain('secret');
    }
    writeFileSync(
      ctx.configPath,
      configYaml(ctx.project).replace('check: bun run lint', `check: echo ${MODEL_KEY}`),
    );
    const value = await run(['start', '--config', ctx.configPath], ctx, { env: fullEnv() });
    expect(value.code).toBe(1);
    expect(value.err).toContain('projects.1.check');
    expect(value.err).not.toContain(MODEL_KEY);
  });
  test('a YAML syntax error names the line without quoting it', async () => {
    const ctx = setup();
    // Built at run time so the secret scanner does not flag the fixture.
    const token = ['ghp', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('_');
    writeFileSync(ctx.configPath, `github:\n  token: ${token}\n   x: : [\n`);
    const result = await run(['start', '--config', ctx.configPath], ctx, { env: fullEnv() });
    expect(result.code).toBe(1);
    expect(result.err).toContain('line 2');
    expect(result.err).not.toContain(token);
  });

  test('keys named like a model or provider key are refused as secrets', async () => {
    const ctx = setup();
    for (const key of ['model_key', 'anthropic_key', 'auth', 'pem']) {
      writeFileSync(ctx.configPath, configYaml(ctx.project, `${key}: hello\n`));
      const result = await run(['start', '--config', ctx.configPath], ctx, { env: fullEnv() });
      expect(result.code).toBe(1);
      expect(result.err).toContain(`${key}: looks like a secret`);
    }
  });
});

describe('orchestrator secrets', () => {
  test('missing secrets are refused without a TTY, naming the variables', async () => {
    const ctx = setup();
    writeFileSync(ctx.configPath, configYaml(ctx.project));
    const {
      FUNNY_FACTORY_MODEL_KEY: _model,
      FUNNY_FACTORY_SANDBOX_CREDENTIAL: _sb,
      ...rest
    } = fullEnv();
    const result = await run(['start', '--config', ctx.configPath], ctx, { env: rest });
    expect(result.code).toBe(1);
    expect(result.err).toContain('FUNNY_FACTORY_MODEL_KEY');
    expect(result.err).toContain('FUNNY_FACTORY_SANDBOX_CREDENTIAL');
    expect(result.prompted).toEqual([]);
  });

  test('missing secrets are prompted for on a TTY', async () => {
    const ctx = setup();
    writeFileSync(ctx.configPath, configYaml(ctx.project));
    const answers: Record<string, string> = {
      FUNNY_FACTORY_MODEL_KEY: MODEL_KEY,
      FUNNY_FACTORY_APP_ID: '5690396',
      FUNNY_FACTORY_APP_PRIVATE_KEY: privateKey,
      FUNNY_FACTORY_SANDBOX_CREDENTIAL: SANDBOX_KEY,
    };
    const asked: string[] = [];
    const result = await run(['start', '--config', ctx.configPath], ctx, {
      isTTY: true,
      prompt: async (question, secret) => {
        asked.push(secret.envName);
        return answers[secret.envName] ?? null;
      },
    });
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    expect(asked).toEqual(Object.keys(answers));
  });

  test('a sandbox credential is not asked for when every project uses a worktree', async () => {
    const ctx = setup();
    writeFileSync(
      ctx.configPath,
      configYaml(ctx.project)
        .replace(/sandbox:\n {2}provider: boat\n/, '')
        .replace('repo: acme/app', 'repo: acme/app\n    workspace: worktree'),
    );
    const { FUNNY_FACTORY_SANDBOX_CREDENTIAL: _sb, ...rest } = fullEnv();
    expect((await run(['start', '--config', ctx.configPath], ctx, { env: rest })).code).toBe(0);
  });

  test('an App id or private key that cannot sign is refused', async () => {
    const ctx = setup();
    writeFileSync(ctx.configPath, configYaml(ctx.project));
    for (const env of [
      { ...fullEnv(), FUNNY_FACTORY_APP_ID: 'abc' },
      { ...fullEnv(), FUNNY_FACTORY_APP_PRIVATE_KEY: 'not a key' },
    ]) {
      const result = await run(['start', '--config', ctx.configPath], ctx, { env });
      expect(result.code).toBe(1);
      expect(result.err).toMatch(/FUNNY_FACTORY_APP_(ID|PRIVATE_KEY)/);
      expect(result.err).not.toContain('not a key');
    }
  });

  test('secrets are removed from the environment once read', async () => {
    const ctx = setup();
    writeFileSync(ctx.configPath, configYaml(ctx.project));
    const env: Record<string, string | undefined> = { ...fullEnv(), PATH: '/usr/bin' };
    expect((await run(['start', '--config', ctx.configPath], ctx, { env })).code).toBe(0);
    expect(
      Object.keys(env)
        .filter((k) => k.startsWith('FUNNY_FACTORY_'))
        .sort(),
    ).toEqual(['FUNNY_FACTORY_HOME']);
    expect(env.PATH).toBe('/usr/bin');
  });

  test('secrets never appear in the output, even when a log line carries one', async () => {
    const ctx = setup();
    // The repository name is logged at start; make it carry the model key.
    writeFileSync(ctx.configPath, configYaml(ctx.project));
    const result = await run(['start', '--config', ctx.configPath], ctx, {
      env: { ...fullEnv(), FUNNY_FACTORY_MODEL_KEY: 'acme' },
    });
    expect(result.code).toBe(0);
    for (const secret of ['acme', SANDBOX_KEY, privateKey.split('\n')[1]]) {
      expect(result.out + result.err).not.toContain(secret);
    }
    expect(result.out).toContain('[redacted]/app (sandbox)');
  });
});

describe('orchestrator status', () => {
  test('a fresh install has no runs', async () => {
    const ctx = setup();
    const result = await run(['status'], ctx);
    expect(result.code).toBe(0);
    expect(result.out).toContain('No factory runs yet.');
    expect(result.out).toContain('Started today: 0');
  });

  test('lists the runs in the store, newest first, with the reason for a wait or failure', async () => {
    const ctx = setup();
    const store = openRunStore(join(ctx.home, 'state.db'));
    store.save({
      id: 'run-1',
      repo: 'acme/app',
      issueNumber: 12,
      state: 'failed',
      prUrl: null,
      reason: 'checks never passed',
      createdAt: '2026-11-13T10:00:00.000Z',
      updatedAt: '2026-11-13T10:30:00.000Z',
    });
    store.save({
      id: 'run-2',
      repo: 'acme/app',
      issueNumber: 14,
      state: 'waiting_ci',
      prUrl: 'https://github.com/acme/app/pull/40',
      reason: null,
      createdAt: '2026-11-13T11:00:00.000Z',
      updatedAt: '2026-11-13T11:05:00.000Z',
    });
    store.close();
    const result = await run(['status'], ctx);
    expect(result.code).toBe(0);
    const lines = result.out.split('\n');
    const second = lines.findIndex((l) => l.includes('acme/app#14'));
    const first = lines.findIndex((l) => l.includes('acme/app#12'));
    expect(second).toBeGreaterThan(-1);
    expect(first).toBeGreaterThan(second);
    expect(lines[second]).toContain('waiting_ci');
    expect(lines[second]).toContain('https://github.com/acme/app/pull/40');
    expect(lines[first]).toContain('failed');
    expect(lines[first]).toContain('checks never passed');
  });
});

describe('orchestrator usage', () => {
  test('an unknown command prints the usage', async () => {
    const ctx = setup();
    const result = await run(['frobnicate'], ctx);
    expect(result.code).toBe(2);
    expect(result.err).toContain('Usage: funny-orchestrator');
  });
});
