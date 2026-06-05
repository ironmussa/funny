/**
 * OpenCodeACPProcess — opencode (https://opencode.ai) as an ACP agent.
 *
 * All behavior now lives in {@link GenericACPProcess}, parameterized by the
 * declarative `opencodeManifest`. This shim only binds the manifest so existing
 * imports / test suites (`opencode-acp.test.ts`) keep constructing
 * `new OpenCodeACPProcess(options)` unchanged.
 *
 * opencode specifics — all expressed as manifest data:
 *   - spawn `opencode acp`; auth is runner-preauth (`opencode auth login`).
 *   - model select via the raw `session/set_model` ACP method (extMethod).
 *   - session modes `build` | `plan` (funny `plan` → plan, else build).
 *   - fork capability under `sessionCapabilities.fork`.
 *   - quirks: TodoWrite plan cards, deferred tool input, orphan-update synth,
 *     MCP capability filtering, gated permissions.
 */

import { opencodeManifest } from '@funny/shared/provider-manifests';

import { GenericACPProcess } from './generic-acp.js';
import type { ClaudeProcessOptions } from './types.js';

export class OpenCodeACPProcess extends GenericACPProcess {
  constructor(options: ClaudeProcessOptions) {
    super(options, opencodeManifest);
  }
}
