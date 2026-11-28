/**
 * The one dispatch point for funny's small helper generations (openspec
 * `thread-recap`, D3): commit messages and thread recaps run on the requesting
 * user's utility model, as a single turn with no tools.
 *
 * Three backends:
 * - `claude` (and legacy `claude-sdk`): one Claude Agent SDK `query()` (plan
 *   mode, no tools, one turn).
 * - Other agent providers (`codex`, `gemini`, `pi`, `cursor`, `opencode`,
 *   `antigravity`, `deepagent`): a single-turn `defaultProcessFactory` run in
 *   plan mode with no tools.
 * - LLM API (`anthropic`, `openai`, `ollama`, `openai-compatible`): `completeOnce`
 *   with the user's own provider key, read the way LLM API threads read it.
 *
 * There is no fallback: a missing credential is `utility-model-unavailable`,
 * never another provider, another user's key or a `process.env` key. Provider
 * keys are never logged or returned.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  completeOnce,
  defaultProcessFactory,
  resolveSDKCliPath,
  type CLIMessage,
  type CompleteOnceError,
} from '@funny/core/agents';
import type { AgentProvider } from '@funny/shared';
import { runAsync } from '@funny/shared/async';
import {
  resolveUtilityModel,
  UTILITY_MODEL_LLM_PROVIDERS,
  UtilityModelSetting,
} from '@funny/shared/contracts/profile';
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
  /** Working directory for CLI/SDK agent backends. */
  cwd?: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** The user's saved utility model; `null` when they never set one. Throws on an invalid saved value. */
export async function loadUtilityModel(userId: string): Promise<UtilityModelSetting | null> {
  const profile = await getServices().profile.getProfile(userId);
  const saved = profile?.utilityModel ?? null;
  if (saved === null) return null;
  const parsed = UtilityModelSetting.safeParse(saved);
  if (!parsed.success) throw new Error('The saved utility model setting is invalid');
  return parsed.data;
}

/** A user-facing sentence for a utility model failure. */
export function describeUtilityModelError(error: UtilityModelError): string {
  if (error.kind === 'utility-model-unavailable') {
    return `The utility model is unavailable: no ${error.provider} API key is saved in Settings > Profile`;
  }
  return error.message;
}

/** Providers whose LLM API endpoint refuses requests without the user's key. */
const KEYED_PROVIDERS: ReadonlySet<string> = new Set(['openai', 'anthropic']);

/** Direct LLM API providers dispatched through `completeOnce`. */
const LLM_API_PROVIDERS: ReadonlySet<string> = new Set(
  UTILITY_MODEL_LLM_PROVIDERS.filter((provider) => provider !== 'claude-sdk'),
);

/** Carries a typed error through `runAsync`, which only knows thrown values. */
class UtilityFailure extends Error {
  constructor(readonly detail: UtilityModelError) {
    super(detail.kind === 'utility-model-unavailable' ? detail.kind : detail.message);
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function toUtilityError(cause: unknown): UtilityModelError {
  if (cause instanceof UtilityFailure) return cause.detail;
  return { kind: 'provider-error', message: messageOf(cause) };
}

/** A Claude alias such as `haiku` as its full model id; a full id passes through. */
function claudeModelId(model: string): string {
  try {
    // SAFETY: resolveModelId only looks the name up in the Claude registry and
    // throws for one it does not know; the catch answers with the name itself.
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
    const queryOptions: Parameters<typeof query>[0]['options'] = {
      cwd: options.cwd,
      model: claudeModelId(setting.model),
      maxTurns: 1,
      permissionMode: 'plan',
      abortController: controller,
      pathToClaudeCodeExecutable: resolveSDKCliPath(),
      systemPrompt: options.system,
      tools: [],
    };
    if (setting.effort) queryOptions.effort = setting.effort;
    gen = query({
      prompt: options.prompt,
      options: queryOptions,
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

async function runAgentProcess(
  setting: UtilityModelSetting,
  options: UtilityGenerationOptions,
  signal: AbortSignal,
): Promise<string> {
  if (signal.aborted) throw signal.reason;
  const prompt = options.system ? `${options.system}\n\n${options.prompt}` : options.prompt;
  const proc = defaultProcessFactory.create({
    // SAFETY: runUtilityGeneration only routes non-LLM, non-Claude agent providers here.
    provider: setting.provider as AgentProvider,
    model: setting.model,
    effort: setting.effort,
    cwd: options.cwd ?? process.cwd(),
    prompt,
    permissionMode: 'plan',
    maxTurns: 1,
    allowedTools: [],
  });

  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    let resultText = '';

    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      proc.removeAllListeners();
      if (!proc.exited) void proc.kill();
    };

    const finish = (outcome: { ok: true; value: string } | { ok: false; error: unknown }) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (outcome.ok) resolve(outcome.value);
      else reject(outcome.error);
    };

    const onAbort = () => {
      finish({ ok: false, error: signal.reason });
    };

    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }

    proc.on('message', (msg: CLIMessage) => {
      if (msg.type === 'assistant') {
        const text = msg.message.content
          .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
          .map((block) => block.text)
          .join('\n');
        if (text) resultText = text;
      } else if (msg.type === 'result') {
        if (msg.is_error) {
          finish({
            ok: false,
            error: new UtilityFailure({
              kind: 'provider-error',
              message: msg.errors?.join('; ') || msg.result || 'Utility model generation failed',
            }),
          });
        } else {
          finish({ ok: true, value: msg.result || resultText });
        }
      }
    });

    proc.on('error', (err) => {
      finish({ ok: false, error: err });
    });

    proc.on('exit', (code) => {
      if (signal.aborted) {
        finish({ ok: false, error: signal.reason });
      } else if (code !== 0 && code !== null && !resultText) {
        finish({
          ok: false,
          error: new UtilityFailure({
            kind: 'provider-error',
            message: `Utility model process exited with code ${code}`,
          }),
        });
      } else {
        finish({ ok: true, value: resultText });
      }
    });

    proc.start();
  });
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
  const backend =
    setting.provider === 'claude' || setting.provider === 'claude-sdk'
      ? runClaudeSdk
      : LLM_API_PROVIDERS.has(setting.provider)
        ? runLlmApi
        : runAgentProcess;
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
