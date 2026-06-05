/**
 * CursorACPProcess — Cursor CLI (https://cursor.com/docs/cli/acp) as an ACP agent.
 *
 * All behavior now lives in {@link GenericACPProcess}, parameterized by the
 * declarative `cursorManifest`. This shim only binds the manifest so existing
 * imports / test suites (`cursor-acp.test.ts`) keep constructing
 * `new CursorACPProcess(options)` unchanged.
 *
 * cursor specifics — all expressed as manifest data:
 *   - spawn `cursor-agent acp`; auth via the `cursor` provider key (or
 *     `cursor-agent login` on the runner).
 *   - model select via the typed `unstable_setSessionModel` ACP method.
 *   - no session-mode switching (autoEdit bypass handled in permission flow).
 *   - fork capability under `sessions.fork`.
 *   - quirks: TodoWrite plan cards, deferred tool input, orphan-update synth,
 *     MCP capability filtering, gated permissions.
 */

import { cursorManifest } from '@funny/shared/provider-manifests';

import { GenericACPProcess } from './generic-acp.js';
import type { ClaudeProcessOptions } from './types.js';

export class CursorACPProcess extends GenericACPProcess {
  constructor(options: ClaudeProcessOptions) {
    super(options, cursorManifest);
  }
}
