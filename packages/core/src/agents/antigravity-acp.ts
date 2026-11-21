/**
 * AntigravityACPProcess — Google's Antigravity CLI (`agy`) as an ACP agent.
 *
 * All behavior lives in {@link GenericACPProcess}, parameterized by the
 * declarative `antigravityManifest`:
 *   - spawn `agy acp` (a subcommand, unlike `gemini --acp`); auth is a Google
 *     login done once on the runner (`agy acp --login`).
 *   - dynamic model catalog from `session/new`, selected with the raw
 *     `session/set_model` ACP method.
 *   - session modes `default` | `plan` via `session/set_mode`; funny's autoEdit
 *     approves each permission request itself.
 *   - no native fork.
 */

import { antigravityManifest } from '@funny/shared/provider-manifests';

import { GenericACPProcess } from './generic-acp.js';
import type { ClaudeProcessOptions } from './types.js';

export class AntigravityACPProcess extends GenericACPProcess {
  constructor(options: ClaudeProcessOptions) {
    super(options, antigravityManifest);
  }
}
