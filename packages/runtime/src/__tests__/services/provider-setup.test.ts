import { EventEmitter } from 'events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  piModels: vi.fn(),
  spawn: vi.fn(),
  mkdir: vi.fn(),
  which: vi.fn(),
  bundled: vi.fn(),
  exists: vi.fn(),
}));
vi.mock('@funny/core/agents', () => ({ discoverPiModels: mocks.piModels }));
vi.mock('child_process', () => ({ spawn: mocks.spawn }));
vi.mock('fs', () => ({ existsSync: mocks.exists, mkdirSync: mocks.mkdir }));
vi.mock('../../utils/codex-binary.js', () => ({ bundledCodexBinary: mocks.bundled }));
vi.mock('../../lib/data-dir.js', () => ({ DATA_DIR: '/tmp/provider-setup-test' }));
vi.mock('../../utils/claude-binary.js', () => ({ resetBinaryCache: vi.fn() }));
vi.mock('../../utils/provider-detection.js', () => ({
  resetProviderCache: vi.fn(),
  getAvailableProviders: async () => new Map([['claude', { sdkAvailable: true }]]),
}));

describe('provider setup', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.mkdir.mockReset();
    mocks.bundled.mockReturnValue(null);
    mocks.exists.mockReturnValue(false);
    vi.stubEnv('CODEX_BINARY_PATH', '');
    vi.stubEnv('CODEX_BIN', '');
    mocks.which.mockReturnValue(null);
    if (typeof Bun !== 'undefined') {
      vi.spyOn(Bun, 'which').mockImplementation(mocks.which);
    } else {
      vi.stubGlobal('Bun', { which: mocks.which });
    }
    vi.stubEnv('PATH', process.env.PATH);
    vi.stubEnv('CURSOR_BINARY_PATH', '');
    for (const key of [
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_AUTH_TOKEN',
      'OPENAI_API_KEY',
      'CODEX_API_KEY',
    ])
      vi.stubEnv(key, '');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('distinguishes integrated providers, missing binaries, and manual setup', async () => {
    const { providerSetupStatus } = await import('../../services/provider-setup.js');
    expect((await providerSetupStatus('claude')).state).toBe('bundled');
    expect((await providerSetupStatus('gemini')).state).toBe('missing');
    expect((await providerSetupStatus('custom')).installable).toBe(false);
  });

  it('uses the bundled Codex CLI and preserves explicit overrides', async () => {
    mocks.bundled.mockReturnValue('/sdk/bin/codex.js');
    const { activateProviderTools } = await import('../../services/provider-setup.js');
    activateProviderTools();
    expect(process.env.CODEX_BINARY_PATH).toBe('/sdk/bin/codex.js');
    vi.stubEnv('CODEX_BINARY_PATH', '/custom/codex');
    activateProviderTools();
    expect(process.env.CODEX_BINARY_PATH).toBe('/custom/codex');
  });

  it('prefers a persistent Codex installation over the bundled CLI', async () => {
    mocks.exists.mockReturnValue(true);
    mocks.bundled.mockReturnValue('/sdk/bin/codex.js');
    const { activateProviderTools } = await import('../../services/provider-setup.js');
    activateProviderTools();
    expect(process.env.CODEX_BINARY_PATH).toBe(
      '/tmp/provider-setup-test/provider-tools/node_modules/.bin/codex',
    );
  });

  it('requires Pi setup without credentials and provides login instructions after installation', async () => {
    mocks.piModels.mockResolvedValue({ ok: false, reason: 'auth_required' });
    const { providerSetupStatus } = await import('../../services/provider-setup.js');
    expect(await providerSetupStatus('pi')).toMatchObject({
      state: 'bundled',
      auth: 'required',
      installable: true,
    });
    mocks.which.mockReturnValue('/tools/pi');
    const installed = await providerSetupStatus('pi');
    expect(installed.state).toBe('installed');
    expect(installed.loginCommand).toContain('/login');
    expect(installed.loginCommand).toContain("'/tools/pi'");
    mocks.piModels.mockResolvedValue({ ok: true, models: [{ modelId: 'provider/model' }] });
    expect((await providerSetupStatus('pi')).auth).toBe('configured');
  });

  it('rejects arbitrary commands and serializes installations, allowing retry after failure', async () => {
    const child = new EventEmitter();
    mocks.spawn.mockReturnValue(child);
    const { startProviderInstall, providerSetupStatus } =
      await import('../../services/provider-setup.js');
    expect(startProviderInstall('claude; echo unsafe')).toBe(false);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(startProviderInstall('gemini')).toBe(true);
    expect(startProviderInstall('codex')).toBe(false);
    expect(mocks.spawn.mock.calls[0][1]).toContain('@google/gemini-cli');
    expect(mocks.spawn.mock.calls[0][2].shell).toBe(false);
    child.emit('close', 1);
    expect((await providerSetupStatus('gemini')).state).toBe('failed');
    expect(startProviderInstall('gemini')).toBe(true);
    child.emit('error', new Error('npm missing'));
    child.emit('close', -1);
    expect((await providerSetupStatus('gemini')).error).toContain('npm');
  });

  it('verifies the binary after npm succeeds', async () => {
    const child = new EventEmitter();
    mocks.spawn.mockReturnValue(child);
    const { startProviderInstall, providerSetupStatus } =
      await import('../../services/provider-setup.js');
    vi.stubEnv('PATH', process.env.PATH);
    startProviderInstall('gemini');
    child.emit('close', 0);
    expect((await providerSetupStatus('gemini')).state).toBe('failed');
    startProviderInstall('gemini');
    mocks.which.mockReturnValue('/tmp/gemini');
    child.emit('close', 0);
    expect((await providerSetupStatus('gemini')).state).toBe('installed');
  });
  it('runs the allowlisted package postinstall with Bun, including after a failed install', async () => {
    vi.stubGlobal('process', {
      ...process,
      versions: { ...process.versions, bun: '1.4.0' },
    });
    const child = new EventEmitter();
    mocks.spawn.mockReturnValue(child);
    const { startProviderInstall } = await import('../../services/provider-setup.js');
    expect(startProviderInstall('claude')).toBe(true);
    expect(mocks.spawn).toHaveBeenLastCalledWith(
      process.execPath,
      [
        'add',
        '--cwd',
        '/tmp/provider-setup-test/provider-tools',
        '--trust',
        '@anthropic-ai/claude-code',
      ],
      expect.objectContaining({ shell: false }),
    );
    child.emit('close', 1);
    expect(startProviderInstall('claude')).toBe(true);
    expect(mocks.spawn.mock.calls[1][1]).toContain('--trust');
  });
  it('finds newly installed tools using the updated PATH instead of the startup PATH', async () => {
    const child = new EventEmitter();
    mocks.spawn.mockReturnValue(child);
    const { startProviderInstall, providerSetupStatus } =
      await import('../../services/provider-setup.js');
    expect(startProviderInstall('gemini')).toBe(true);
    mocks.which.mockImplementation((command, options) =>
      command === 'gemini' &&
      options?.PATH?.startsWith('/tmp/provider-setup-test/provider-tools/node_modules/.bin')
        ? '/tmp/provider-setup-test/provider-tools/node_modules/.bin/gemini'
        : null,
    );
    child.emit('close', 0);
    expect((await providerSetupStatus('gemini')).state).toBe('installed');
    expect(mocks.which).toHaveBeenCalledWith('cursor-agent', { PATH: process.env.PATH });
  });
  it('reports directory errors and allows a subsequent retry', async () => {
    mocks.mkdir.mockImplementationOnce(() => {
      throw new Error('permission denied');
    });
    mocks.spawn.mockReturnValue(new EventEmitter());
    const { startProviderInstall, providerSetupStatus } =
      await import('../../services/provider-setup.js');
    expect(startProviderInstall('gemini')).toBe(true);
    expect((await providerSetupStatus('gemini')).state).toBe('failed');
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(startProviderInstall('gemini')).toBe(true);
    expect((await providerSetupStatus('gemini')).state).toBe('installing');
  });
});

describe('provider authentication', () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each([
    [0, 'connected'],
    [1, 'required'],
    [2, 'unknown'],
    [null, 'unknown'],
  ])('maps status exit %s to %s', async (code, state) => {
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('CODEX_API_KEY', '');
    const child = new EventEmitter();
    mocks.spawn.mockReturnValue(child);
    const { checkProviderAuth } = await import('../../services/provider-setup.js');
    const result = checkProviderAuth('codex', '/tools/codex');
    child.emit('close', code);
    expect(await result).toBe(state);
    expect(mocks.spawn).toHaveBeenLastCalledWith(
      '/tools/codex',
      ['login', 'status'],
      expect.objectContaining({ shell: false, timeout: 10000 }),
    );
  });
  it('accepts a configured key without launching a login check', async () => {
    mocks.spawn.mockClear();
    const { checkProviderAuth } = await import('../../services/provider-setup.js');
    expect(await checkProviderAuth('claude', '/tools/claude', true)).toBe('configured');
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
