/**
 * The one dispatch point for funny's small helper generations (openspec
 * `thread-recap`, D3): commit messages and thread recaps run on the requesting
 * user's utility model, as a single turn with no tools.
 *
 * Two backends:
 * - `claude-sdk`: one Claude Agent SDK `query()` (plan mode, no tools, one turn).
 * - LLM API (`anthropic`, `openai`, `ollama`, `openai-compatible`): `completeOnce`
 *   with the user's own provider key, read the way LLM API threads read it.
 *
 * There is no fallback: a missing credential is `utility-model-unavailable`,
 * never another provider, another user's key or a `process.env` key. Provider
 * keys are never logged or returned.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { completeOnce, resolveSDKCliPath, type CompleteOnceError } from '@funny/core/agents';
import { runAsync } from '@funny/shared/async';
import { resolveUtilityModel, type UtilityModelSetting } from '@funny/shared/contracts/profile';
import { resolveModelId, type AgentModel } from '@funny/shared/models';
import { ResultAsync } from 'neverthrow';

import { getServices } from './service-registry.js';

export type UtilityModelError =
  | { kind: 'utility-model-unavailable'; provider: string }
  | { kind: 'timeout'; message: string }
  | { kind: 'provider-error'; message: string };

export interface UtilityGenerationOptions {
  /** The user's saved setting; `null` is the default (Claude Haiku through the SDK). */
  setting: UtilityModelSetting | null;
  /** The requesting user: their provider key is the only one an LLM API backend uses. */
  userId: string;
  system: string;
  prompt: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Working directory of the SDK query (claude-sdk backend only). */
  cwd?: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** Providers whose LLM API endpoint refuses requests without the user's key. */
const KEYED_PROVIDERS: ReadonlySet<string> = new Set(['openai', 'anthropic']);

/** Carries a typed error through `runAsync`, which only knows thrown values. */
class UtilityFailure extends Error {
  constructor(readonly detail: UtilityModelError) {
    super(detail.kind === 'utility-model-unavailable' ? detail.kind : detail.message);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toUtilityError(error: unknown): UtilityModelError {
  if (error instanceof UtilityFailure) return error.detail;
  return { kind: 'provider-error', message: messageOf(error) };
}

/** A Claude alias such as `haiku` as its full model id; a full id passes through. */
function claudeModelId(model: string): string {
  try {
    return resolveModelId('claude', model as AgentModel);
  } catch {
    return model;
  }
}

async function runClaudeSdk(
  setting: UtilityModelSetting,
  options: UtilityGenerationOptions,
  signal: AbortSignal,
): Promise<string> {
  const controller = new AbortController();
  let gen: ReturnType<typeof query> | undefined;
  const close = () => {
    const owned = gen;
    gen = undefined;
    owned?.close();
  };
  const abort = () => {
    controller.abort(signal.reason);
    close();
  };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    gen = query({
      prompt: options.prompt,
      options: {
        cwd: options.cwd,
        model: claudeModelId(setting.model),
        maxTurns: 1,
        permissionMode: 'plan',
        abortController: controller,
        pathToClaudeCodeExecutable: resolveSDKCliPath(),
        systemPrompt: options.system,
        tools: [],
      },
    });
    let resultText = '';
    for await (const msg of gen) {
      if (msg.type === 'assistant') {
        const text = msg.message.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n');
        if (text) resultText = text;
      }
      if (msg.type === 'result') {
        return ('result' in msg && msg.result) || resultText;
      }
    }
    return resultText;
  } finally {
    signal.removeEventListener('abort', abort);
    close();
  }
}

function fromCompleteError(error: CompleteOnceError): UtilityModelError {
  if (error.kind === 'missing-credentials') {
    return { kind: 'utility-model-unavailable', provider: error.provider };
  }
  return { kind: 'provider-error', message: error.message };
}

async function runLlmApi(
  setting: UtilityModelSetting,
  options: UtilityGenerationOptions,
  signal: AbortSignal,
): Promise<string> {
  // Ollama takes no key; every other provider uses the user's own, if any.
  const apiKey =
    setting.provider === 'ollama'
      ? undefined
      : ((await getServices().profile.getProviderKey(options.userId, setting.provider)) ??
        undefined);
  if (KEYED_PROVIDERS.has(setting.provider) && !apiKey) {
    throw new UtilityFailure({ kind: 'utility-model-unavailable', provider: setting.provider });
  }
  if (signal.aborted) throw signal.reason;
  const result = await completeOnce({
    provider: setting.provider,
    model: setting.model,
    apiKey,
    baseURL: setting.baseURL,
    system: options.system,
    prompt: options.prompt,
    signal,
  });
  if (result.isErr()) {
    // Aborted by the timeout or the caller: let runAsync report why.
    if (result.error.kind === 'aborted' && signal.aborted) throw signal.reason;
    throw new UtilityFailure(fromCompleteError(result.error));
  }
  return result.value;
}

/** One generation on the user's utility model: the text, or why there is none. */
export function runUtilityGeneration(
  options: UtilityGenerationOptions,
): ResultAsync<string, UtilityModelError> {
  const setting = resolveUtilityModel(options.setting);
  const backend = setting.provider === 'claude-sdk' ? runClaudeSdk : runLlmApi;
  return ResultAsync.fromPromise(
    runAsync((signal) => backend(setting, options, signal), {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      timeoutError: () =>
        new UtilityFailure({ kind: 'timeout', message: 'Utility model generation timed out' }),
    }),
    toUtilityError,
  );
}
