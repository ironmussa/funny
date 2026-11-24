import type { UtilityModelSetting } from '@funny/shared/contracts/profile';

import { log } from '../lib/logger.js';
import { COMMIT_MESSAGE_SYSTEM_PROMPT } from './pipeline-prompts.js';
import {
  describeUtilityModelError,
  loadUtilityModel,
  runUtilityGeneration,
} from './utility-model.js';

/** A commit message for `prompt`, generated on the requesting user's utility model. */
export async function generateCommitMessage(options: {
  userId: string;
  cwd: string;
  prompt: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ text: string } | { error: string }> {
  let setting: UtilityModelSetting | null;
  try {
    setting = await loadUtilityModel(options.userId);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    log.error('Could not load the utility model for a commit message', {
      namespace: 'git',
      error: message,
    });
    return { error: message };
  }
  const result = await runUtilityGeneration({
    setting,
    userId: options.userId,
    cwd: options.cwd,
    system: COMMIT_MESSAGE_SYSTEM_PROMPT,
    prompt: options.prompt,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
  if (result.isErr()) {
    const message =
      result.error.kind === 'timeout'
        ? 'Commit message generation timed out'
        : describeUtilityModelError(result.error);
    log.error('Utility model error generating commit message', {
      namespace: 'git',
      kind: result.error.kind,
      error: message,
    });
    return { error: message };
  }
  return result.value ? { text: result.value } : { error: 'No output received' };
}
