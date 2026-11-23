/**
 * A read-only agent (the issue factory's reviewer, triage and sentinel): only
 * reading tools, decided before any saved rule, and Bash held by the SDK's OS
 * sandbox. The sandbox itself is the SDK's; this checks what funny asks of it.
 */
import { beforeEach, describe, expect, test } from 'bun:test';

import { READ_ONLY_AGENT_TOOLS } from '@funny/shared/models';

import {
  detectReadOnlySandboxMode,
  escapeSocketPaths,
  readOnlyDenial,
  readOnlySandboxSettings,
  resetReadOnlySandboxMode,
} from '../agents/read-only.js';
import { SDKClaudeProcess } from '../agents/sdk-claude.js';

describe('readOnlyDenial', () => {
  test('reading tools and Bash pass; writing, web, subagents and MCP tools do not', () => {
    for (const tool of ['Read', 'Glob', 'Grep', 'Bash']) {
      expect(readOnlyDenial(tool, { command: 'git log' })).toBeNull();
    }
    for (const tool of ['Edit', 'Write', 'NotebookEdit', 'WebFetch', 'Task', 'mcp__funny__x']) {
      expect(readOnlyDenial(tool, {})).toContain('may only read');
    }
  });

  test('a command that asks to leave the sandbox is denied', () => {
    expect(
      readOnlyDenial('Bash', { command: 'git push', dangerouslyDisableSandbox: true }),
    ).toContain('sandbox');
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
