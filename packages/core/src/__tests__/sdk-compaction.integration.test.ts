/**
 * Opt-in integration test — exercises the REAL Claude Agent SDK to prove the
 * slash-command pipeline actually executes `/compact` (emits a
 * `compact_boundary` system message) and that the `init` message exposes the
 * slash-command list our send-boundary guardrail relies on.
 *
 * Makes real API calls (uses a Claude subscription / API key) and is slow
 * (~30–60s), so it is SKIPPED by default. Run explicitly with:
 *
 *   RUN_SDK_INTEGRATION=1 bunx vitest run src/__tests__/sdk-compaction.integration.test.ts
 *
 * This complements the fast unit tests (isPureSlashCommand / buildEffectivePrompt
 * / extractSlashCommandName), which cover the regex + prefix logic but cannot
 * prove the SDK end of the contract — exactly what regressed in the original
 * "/compact doesn't compact" bug.
 */

import { existsSync, readdirSync } from 'fs';
import { dirname, join } from 'path';

import { query } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, test } from 'vitest';

import { resolveSDKCli } from '../agents/resolve-sdk-cli.js';

/**
 * Resolve the SDK CLI binary. Prefer the production resolver; fall back to
 * scanning Bun's `.bun` store, whose symlink layout the production resolver's
 * `createRequire`/cwd walk doesn't see under the vitest module loader.
 */
function resolveCliForTest(): { path: string; kind: 'js' | 'native' } {
  try {
    return resolveSDKCli();
  } catch {
    // Walk up to the repo root, then scan node_modules/.bun for the native pkg.
    const binName = process.platform === 'win32' ? 'claude.exe' : 'claude';
    const nativePkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
    let dir = process.cwd();
    for (;;) {
      const bunStore = join(dir, 'node_modules', '.bun');
      if (existsSync(bunStore)) {
        for (const entry of readdirSync(bunStore)) {
          if (!entry.startsWith('@anthropic-ai+claude-agent-sdk-')) continue;
          const candidate = join(bunStore, entry, 'node_modules', nativePkg, binName);
          if (existsSync(candidate)) return { path: candidate, kind: 'native' };
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    throw new Error('Integration test: could not locate the Claude Agent SDK CLI binary');
  }
}

const RUN = !!process.env.RUN_SDK_INTEGRATION;
const suite = RUN ? describe : describe.skip;

// A controllable streaming-input channel so we can build context then inject
// `/compact` on the same live session (mirrors funny's steerable input path).
function makeChannel() {
  const q: any[] = [];
  const waiters: Array<() => void> = [];
  let closed = false;
  return {
    push(msg: any) {
      q.push(msg);
      const w = waiters.shift();
      if (w) w();
    },
    close() {
      closed = true;
      waiters.splice(0).forEach((w) => w());
    },
    async *gen() {
      while (true) {
        const n = q.shift();
        if (n) {
          yield n;
          continue;
        }
        if (closed) return;
        await new Promise<void>((r) => waiters.push(r));
      }
    },
  };
}

function userMsg(text: string) {
  return {
    type: 'user',
    session_id: '',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  };
}

suite('SDK slash-command pipeline (real SDK)', () => {
  test('/compact emits a compact_boundary and init exposes slash_commands', async () => {
    const cli = resolveCliForTest();
    const ch = makeChannel();
    ch.push(userMsg('Reply with a short one-sentence fact about cats.'));

    const options = {
      pathToClaudeCodeExecutable: cli.path,
      model: 'claude-haiku-4-5-20251001',
      cwd: '/tmp',
      permissionMode: 'bypassPermissions' as const,
      allowDangerouslySkipPermissions: true,
      systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const },
      ...(cli.kind === 'js' ? { executable: 'node' as const } : {}),
    };

    let initSlashCommands: string[] | undefined;
    let sawCompactBoundary = false;
    let results = 0;
    let sentCompact = false;

    for await (const m of query({ prompt: ch.gen(), options }) as AsyncIterable<any>) {
      if (m.type === 'system' && m.subtype === 'init') {
        initSlashCommands = m.slash_commands;
      } else if (m.type === 'system' && m.subtype === 'compact_boundary') {
        sawCompactBoundary = true;
      } else if (m.type === 'result') {
        results++;
        if (results === 1) {
          ch.push(userMsg('Now a short one-sentence fact about dogs.'));
        } else if (results === 2 && !sentCompact) {
          sentCompact = true;
          ch.push(userMsg('/compact'));
        } else {
          ch.close();
        }
      }
    }

    // The init message must carry the command list our guardrail keys off.
    expect(Array.isArray(initSlashCommands)).toBe(true);
    expect(initSlashCommands).toContain('compact');
    expect(initSlashCommands).toContain('context');

    // And `/compact` must actually run as a command (not be echoed to the model).
    expect(sawCompactBoundary).toBe(true);
  }, 180_000);
});
