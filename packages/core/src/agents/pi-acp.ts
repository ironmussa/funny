/**
 * PiACPProcess — the `pi-acp` adapter (https://github.com/svkozak/pi-acp) as an
 * ACP agent.
 *
 * All behavior now lives in {@link GenericACPProcess}, parameterized by the
 * declarative `piManifest`. This shim only binds the manifest so existing
 * imports / test suites (`pi-acp.test.ts`) keep constructing
 * `new PiACPProcess(options)` unchanged.
 *
 * pi specifics — all expressed as manifest data:
 *   - spawn `pi-acp`; auth is runner-preauth.
 *   - model select via the typed `unstable_setSessionModel` ACP method.
 *   - no session-mode switching.
 *   - fork capability under `sessions.fork`.
 *   - quirks: plan rendered as `**Plan:**` markdown text (not a card), first
 *     message banner stripped, auto-allow permissions (no gating), MCP
 *     capability filtering. pi never defers tool input nor synthesizes a
 *     tool_use for an orphan update (terminal update emits only a tool_result).
 */

import { piManifest } from '@funny/shared/provider-manifests';

import { GenericACPProcess } from './generic-acp.js';
import type { ClaudeProcessOptions } from './types.js';

export class PiACPProcess extends GenericACPProcess {
  constructor(options: ClaudeProcessOptions) {
    super(options, piManifest);
  }
}
