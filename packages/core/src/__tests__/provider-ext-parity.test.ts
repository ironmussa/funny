/**
 * Phase B §5 — the "add = install" proof, the rigorous built-in-as-external
 * fallback. We take the bundled `cursor` manifest, serialize it to an external
 * `funny.provider.json` under a NEW id (`cursor-ext`), load it purely from disk
 * (no in-tree code for `cursor-ext`), and assert the loaded provider drives the
 * exact same `translateUpdate` behavior as the bundled CursorACPProcess.
 *
 * This proves a disk-loaded manifest produces an identical CLIMessage stream to
 * the compiled-in provider — i.e. adding an ACP provider is genuinely just an
 * install.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { PROVIDER_MANIFEST_SCHEMA_VERSION } from '@funny/shared/provider-manifest-schema';
import { ACP_MANIFESTS } from '@funny/shared/provider-manifests';

import { CursorACPProcess } from '../agents/cursor-acp.js';
import { defaultProcessFactory } from '../agents/process-factory.js';
import { _clearRunnerManifests, loadProviderExtensions } from '../agents/provider-extensions.js';
import type { CLIMessage } from '../agents/types.js';

let dir: string;

const baseOpts = {
  threadId: 't',
  projectPath: '/tmp',
  prompt: 'hi',
  model: 'default',
  permissionMode: 'autoEdit',
} as any;

function capture(proc: { on: (e: string, h: (m: CLIMessage) => void) => unknown }): CLIMessage[] {
  const out: CLIMessage[] = [];
  proc.on('message', (m: CLIMessage) => out.push(m));
  return out;
}

function translate(proc: unknown, update: unknown): void {
  (proc as { translateUpdate: (u: unknown) => void }).translateUpdate(update);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'funny-ext-parity-'));
  _clearRunnerManifests();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  _clearRunnerManifests();
});

describe('cursor-as-external provider parity (§5)', () => {
  test('a disk-loaded cursor manifest registers and matches the built-in stream', () => {
    // Write the bundled cursor manifest to disk as an external provider, but
    // under a fresh id so it does not collide with the built-in.
    const manifest = { ...JSON.parse(JSON.stringify(ACP_MANIFESTS.cursor)), id: 'cursor-ext' };
    const extDir = join(dir, 'funny-cursor-ext');
    mkdirSync(extDir, { recursive: true });
    writeFileSync(
      join(extDir, 'package.json'),
      JSON.stringify({ name: 'funny-cursor-ext', funny: { provider: 'manifest.json' } }),
    );
    writeFileSync(
      join(extDir, 'manifest.json'),
      JSON.stringify({ schemaVersion: PROVIDER_MANIFEST_SCHEMA_VERSION, manifest }),
    );

    const res = loadProviderExtensions(dir);
    expect(res.errors).toEqual([]);
    expect(res.loaded.map((l) => l.id)).toEqual(['cursor-ext']);

    // Resolve the external provider from the registry (no in-tree class for it).
    const external = defaultProcessFactory.create({ ...baseOpts, provider: 'cursor-ext' });
    const builtin = new CursorACPProcess({ ...baseOpts });

    const extMsgs = capture(external as any);
    const biMsgs = capture(builtin as any);

    // The diff-block edit recovery — one of cursor's signature quirks.
    const update = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'edit-1',
      status: 'completed',
      kind: 'edit',
      title: 'Edit File',
      content: [
        {
          type: 'diff',
          path: '/repo/src/sample.ts',
          oldText: 'a',
          newText: 'b',
        },
      ],
    };
    translate(external, update);
    translate(builtin, update);

    // Both produce a synthetic Edit tool_use + a tool_result. Compare the
    // structural content (ids are random per emission).
    const shape = (msgs: CLIMessage[]) =>
      msgs.map((m) =>
        m.type === 'assistant'
          ? m.message.content.map((c: any) => ({ t: c.type, name: c.name, input: c.input }))
          : m.type === 'user'
            ? m.message.content.map((c: any) => ({ t: c.type }))
            : { t: m.type },
      );

    expect(extMsgs.length).toBeGreaterThan(0);
    expect(shape(extMsgs)).toEqual(shape(biMsgs));

    const extUse = extMsgs.find((m) => m.type === 'assistant');
    if (!extUse || extUse.type !== 'assistant') throw new Error('unreachable');
    const block = extUse.message.content[0] as any;
    expect(block).toMatchObject({ type: 'tool_use', name: 'Edit' });
    expect(block.input).toMatchObject({ file_path: '/repo/src/sample.ts', old_string: 'a', new_string: 'b' });
  });
});
