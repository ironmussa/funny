/**
 * CodexACPProcess — codex (`@zed-industries/codex-acp`) as an ACP agent.
 *
 * All behavior now lives in {@link GenericACPProcess}, parameterized by the
 * declarative `codexManifest`. This shim only binds the manifest so existing
 * imports / test suites (`codex-acp.test.ts`) keep constructing
 * `new CodexACPProcess(options)` unchanged.
 *
 * codex specifics — all expressed as manifest data:
 *   - spawn `codex-acp`; auth via the `openai` provider key.
 *   - model select via the typed `unstable_setSessionModel` ACP method.
 *   - session modes read-only | auto | full-access (plan → read-only,
 *     autoEdit → full-access, else auto), set via setSessionMode.
 *   - fork capability under `sessions.fork`.
 *   - quirks: bufferPreambleAsThink (route `[cwd …] (reason)` preamble
 *     tool_calls into a Think card; a plan closes any in-flight Task call),
 *     plan rendered as `**Plan:**` markdown text, gated permissions. codex
 *     never defers tool input nor synthesizes a tool_use for an orphan update.
 */

import { codexManifest } from '@funny/shared/provider-manifests';

import { GenericACPProcess } from './generic-acp.js';
import type { ClaudeProcessOptions } from './types.js';

export class CodexACPProcess extends GenericACPProcess {
  constructor(options: ClaudeProcessOptions) {
    super(options, codexManifest);
  }
}
