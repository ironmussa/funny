/**
 * A read-only agent (the issue factory's reviewer, triage and sentinel): only
 * reading tools, decided before any saved rule, and Bash held by the SDK's OS
 * sandbox. The sandbox itself is the SDK's; this checks what funny asks of it.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { READ_ONLY_AGENT_TOOLS } from '@funny/shared/models';

import {
  detectReadOnlySandboxMode,
  escapeSocketPaths,
  readOnlyDenial,
  readOnlySandboxSettings,
  resetReadOnlySandboxMode,
  withSettingsHooksOff,
} from '../agents/read-only.js';
import { SDKClaudeProcess } from '../agents/sdk-claude.js';

describe('readOnlyDenial', () => {
  test('reading tools and Bash pass; writing, web, subagents and MCP tools do not', () => {
    for (const tool of ['Read', 'Glob', 'Grep', 'Bash']) {
      expect(readOnlyDenial(tool, { command: 'git log', file_path: '/w/a.ts' }, ['/w'])).toBeNull();
    }
    for (const tool of ['Edit', 'Write', 'NotebookEdit', 'WebFetch', 'Task', 'mcp__funny__x']) {
      expect(readOnlyDenial(tool, {}, ['/w'])).toContain('may only read');
    }
  });

  test('a command that asks to leave the sandbox is denied', () => {
    expect(
      readOnlyDenial('Bash', { command: 'git push', dangerouslyDisableSandbox: true }, ['/w']),
    ).toContain('sandbox');
  });
});

describe('reading tools stay in the checkout (they run outside the sandbox)', () => {
  const base = mkdtempSync(join(tmpdir(), 'ro-roots-'));
  const checkout = join(base, 'checkout');
  const inputs = join(base, 'inputs');
  const secret = join(base, 'funny-data');
  mkdirSync(checkout);
  mkdirSync(inputs);
  mkdirSync(secret);
  writeFileSync(join(secret, 'encryption.keys.json'), '{}');
  writeFileSync(join(inputs, 'issue.md'), '# Issue');
  symlinkSync(secret, join(checkout, 'innocent'));
  const roots = [checkout, inputs];

  test('a file of the checkout or of the role inputs can be read', () => {
    expect(readOnlyDenial('Read', { file_path: join(checkout, 'src/a.ts') }, roots)).toBeNull();
    expect(readOnlyDenial('Read', { file_path: join(inputs, 'issue.md') }, roots)).toBeNull();
    expect(readOnlyDenial('Grep', { pattern: 'x' }, roots)).toBeNull();
  });

  test("funny's data, or any file outside, cannot", () => {
    expect(
      readOnlyDenial('Read', { file_path: join(secret, 'encryption.keys.json') }, roots),
    ).toContain('outside');
    expect(readOnlyDenial('Read', { file_path: '/etc/passwd' }, roots)).toContain('outside');
    expect(readOnlyDenial('Grep', { pattern: 'key', path: secret }, roots)).toContain('outside');
    expect(readOnlyDenial('Glob', { pattern: `${secret}/**` }, roots)).toContain('outside');
    expect(
      readOnlyDenial('Read', { file_path: join(checkout, '../funny-data/x') }, roots),
    ).toContain('outside');
  });

  test('nor through a symlink inside the checkout', () => {
    expect(
      readOnlyDenial('Read', { file_path: join(checkout, 'innocent/encryption.keys.json') }, roots),
    ).toContain('outside');
  });
});

describe('readOnlySandboxSettings', () => {
  const settings = readOnlySandboxSettings('/work/tree', '/home/u');

  test('Bash runs sandboxed or not at all', () => {
    expect(settings).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
    });
  });

  test('no writes to the checkout and no network', () => {
    expect(settings.filesystem?.denyWrite).toEqual(['/work/tree']);
    expect(settings.network).toMatchObject({ allowedDomains: [], strictAllowlist: true });
  });

  test('no GitHub or provider credentials', () => {
    const vars = settings.credentials?.envVars?.map((v) => `${v.name}:${v.mode}`) ?? [];
    expect(vars).toContain('GH_TOKEN:deny');
    expect(vars).toContain('GITHUB_TOKEN:deny');
    expect(vars).toContain('ANTHROPIC_API_KEY:deny');
    const files = settings.credentials?.files?.map((f) => f.path) ?? [];
    expect(files).toContain('/home/u/.config/gh');
    expect(files).toContain('/home/u/.git-credentials');
    expect(files).toContain('/home/u/.funny');
    expect(files).toContain('/home/u/.claude/.credentials.json');
    const withData = readOnlySandboxSettings('/w', '/home/u', 'strict', 0, ['/srv/funny-data']);
    expect(withData.credentials?.files?.map((f) => f.path)).toContain('/srv/funny-data');
  });
});

describe('the socket-denylist mode, for hosts that refuse nested user namespaces', () => {
  const settings = readOnlySandboxSettings('/work/tree', '/home/u', 'socket-denylist', 1000);

  test('allows Unix sockets but hides the ones that run code outside the sandbox', () => {
    expect(settings.network).toMatchObject({
      allowedDomains: [],
      strictAllowlist: true,
      allowAllUnixSockets: true,
    });
    expect(settings.filesystem?.denyRead).toEqual(escapeSocketPaths(1000));
    expect(escapeSocketPaths(1000)).toContain('/run/user/1000');
    expect(escapeSocketPaths(1000)).toContain('/var/run/docker.sock');
    expect(escapeSocketPaths(1000)).toContain('/tmp/tmux-1000');
  });

  test('keeps every other guard of the strict mode', () => {
    expect(settings).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: { denyWrite: ['/work/tree'] },
    });
  });

  test('the strict mode does not allow Unix sockets', () => {
    expect(readOnlySandboxSettings('/w', '/h').network).not.toHaveProperty('allowAllUnixSockets');
  });
});

describe('detectReadOnlySandboxMode', () => {
  beforeEach(() => resetReadOnlySandboxMode());

  test('strict where a nested user namespace works, socket-denylist where it does not', async () => {
    expect(await detectReadOnlySandboxMode(async () => true, 'linux')).toBe('strict');
    resetReadOnlySandboxMode();
    expect(await detectReadOnlySandboxMode(async () => false, 'linux')).toBe('socket-denylist');
  });

  test('probes once per process', async () => {
    let probes = 0;
    const probe = async () => {
      probes += 1;
      return false;
    };
    await detectReadOnlySandboxMode(probe, 'linux');
    await detectReadOnlySandboxMode(probe, 'linux');
    expect(probes).toBe(1);
  });

  test('off Linux it is strict, without probing', async () => {
    let probed = false;
    const mode = await detectReadOnlySandboxMode(async () => {
      probed = true;
      return false;
    }, 'darwin');
    expect(mode).toBe('strict');
    expect(probed).toBe(false);
  });
});

describe('the pre-tool hook of a read-only Claude agent', () => {
  const hook = (proc: SDKClaudeProcess, tool: string, toolInput: unknown) =>
    (proc as any).preToolUseHook({ tool_name: tool, tool_input: toolInput }, undefined, {
      signal: new AbortController().signal,
    });
  let lookups = 0;
  let bypasses = 0;
  const proc = new SDKClaudeProcess({
    prompt: 'review',
    cwd: '/work/tree',
    readOnly: true,
    allowedTools: [...READ_ONLY_AGENT_TOOLS],
    // A saved "always allow" that would let anything through.
    permissionRuleLookup: async () => {
      lookups += 1;
      return { decision: 'allow' };
    },
    bypassExecutor: async () => {
      bypasses += 1;
      return { output: 'ran on the host' };
    },
  });

  test('a writing tool is denied even when a saved rule allows it', async () => {
    const decision = await hook(proc, 'Edit', { file_path: '/work/tree/a.ts' });
    expect(decision.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  test('Bash is allowed into the sandbox, without saved rules or the host executor', async () => {
    const decision = await hook(proc, 'Bash', { command: 'cat ~/.claude/settings.json' });
    expect(decision.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(lookups).toBe(0);
    expect(bypasses).toBe(0);
  });
});

describe('withSettingsHooksOff', () => {
  test("turns the settings files' hooks off and keeps the other flag settings", () => {
    expect(withSettingsHooksOff({ fastMode: true })).toEqual({
      fastMode: true,
      disableAllHooks: true,
    });
    expect(withSettingsHooksOff(undefined)).toEqual({ disableAllHooks: true });
    // A settings file path is not an object of flag settings: replaced.
    expect(withSettingsHooksOff('/tmp/settings.json')).toEqual({ disableAllHooks: true });
  });
});
