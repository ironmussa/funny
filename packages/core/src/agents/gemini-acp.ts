/**
 * GeminiACPProcess — the Gemini CLI as an ACP agent.
 *
 * All behavior now lives in {@link GenericACPProcess}, parameterized by the
 * declarative `geminiManifest`. This shim only binds the manifest so existing
 * imports / test suites (`gemini-acp.test.ts`) keep constructing
 * `new GeminiACPProcess(options)` unchanged.
 *
 * gemini specifics — all expressed as manifest data:
 *   - spawn `gemini --acp`; auth via the `gemini` provider key.
 *   - model select via the `--model` CLI arg (modelVia: 'cli-arg').
 *   - permission/mode applied via the `--yolo` launch flag under funny's
 *     autoEdit (modeVia: 'cli-flag'); the `gemini-trust-folder` prelaunch
 *     marks the cwd trusted so --yolo isn't downgraded.
 *   - fork capability under `sessions.fork`.
 *   - quirks: bufferPreambleAsThink (preamble tool_calls → Think card),
 *     synthToolUseFromOrphanUpdate (synthesize a tool_use when a completed
 *     tool_call_update arrives with no prior tool_call), plan rendered as
 *     `**Plan:**` markdown text, gated permissions.
 */

import { geminiManifest } from '@funny/shared/provider-manifests';

import { GenericACPProcess } from './generic-acp.js';
import type { ClaudeProcessOptions } from './types.js';

export class GeminiACPProcess extends GenericACPProcess {
  constructor(options: ClaudeProcessOptions) {
    super(options, geminiManifest);
  }
}
