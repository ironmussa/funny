import { UtilityModelSetting } from '@funny/shared/contracts/profile';

import { log } from '../lib/logger.js';
import { COMMIT_MESSAGE_SYSTEM_PROMPT } from './pipeline-prompts.js';
import { getServices } from './service-registry.js';
import { runUtilityGeneration, type UtilityModelError } from './utility-model.js';

/** The requesting user's saved utility model; `null` when they never set one. */
async function loadUtilityModel(userId: string): Promise<UtilityModelSetting | null> {
  const profile = await getServices().profile.getProfile(userId);
  const saved = profile?.utilityModel ?? null;
  if (saved === null) return null;
  const parsed = UtilityModelSetting.safeParse(saved);
  if (!parsed.success) throw new Error('The saved utility model setting is invalid');
  return parsed.data;
}

function describe(error: UtilityModelError): string {
  if (error.kind === 'utility-model-unavailable') {
    return `The utility model is unavailable: no ${error.provider} API key is saved in Settings > Profile`;
  }
  return error.message;
}

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
        : describe(result.error);
    log.error('Utility model error generating commit message', {
      namespace: 'git',
      kind: result.error.kind,
      error: message,
    });
    return { error: message };
  }
  return result.value ? { text: result.value } : { error: 'No output received' };
}
