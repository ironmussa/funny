/**
 * One-shot Chat Completions call (openspec `thread-recap`, D3).
 *
 * `completeOnce` sends ONE `POST {baseURL}/chat/completions` with a system and a
 * user message and no tools, and answers the assistant's text. It is the LLM API
 * backend of funny's helper generations (commit messages, thread recaps): the
 * same request shape as `AgentExecutor`, without its tool loop.
 *
 * Credentials are the caller's only. A provider that needs a key (`openai`,
 * `anthropic`) without one is refused before anything is resolved, so
 * `ModelFactory`'s `process.env` key fallback never stands in for a missing
 * user key. Error messages never carry the key.
 */

import { parseExternalPayload } from '@funny/shared/json-validation';
import { errAsync, ResultAsync } from 'neverthrow';
import { z } from 'zod';

import { assertNotImds } from './agent-executor.js';
import { ModelFactory } from './model-factory.js';

/** Providers whose endpoint needs the caller's API key. */
const KEYED_PROVIDERS: ReadonlySet<string> = new Set(['openai', 'anthropic']);

const MAX_ERROR_BODY = 300;

export interface CompleteOnceOptions {
  provider: string;
  model: string;
  /** The caller's key. Required for `openai` / `anthropic`; never read from the environment. */
  apiKey?: string;
  baseURL?: string;
  system: string;
  prompt: string;
  signal?: AbortSignal;
  /** Injected for tests; the default has no configured keys. */
  modelFactory?: ModelFactory;
}

export type CompleteOnceError =
  | { kind: 'missing-credentials'; provider: string }
  | { kind: 'aborted'; message: string }
  | { kind: 'provider-error'; message: string; status?: number };

const chatResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable().optional() }).passthrough(),
      }),
    )
    .optional(),
  error: z.object({ message: z.string().optional() }).passthrough().optional(),
});

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function toError(cause: unknown, signal: AbortSignal | undefined): CompleteOnceError {
  if (signal?.aborted || (cause instanceof Error && cause.name === 'AbortError')) {
    return { kind: 'aborted', message: signal?.reason ? messageOf(signal.reason) : 'Aborted' };
  }
  if (isObject(cause) && 'kind' in cause) {
    return cause as CompleteOnceError;
  }
  return { kind: 'provider-error', message: messageOf(cause) };
}

async function post(options: CompleteOnceOptions, apiKey: string | undefined): Promise<string> {
  const factory = options.modelFactory ?? new ModelFactory();
  const resolved = factory.resolve(options.provider, options.model, {
    apiKey,
    baseURL: options.baseURL,
  });
  const url = `${resolved.baseURL.replace(/\/$/, '')}/chat/completions`;
  await assertNotImds(url);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (resolved.apiKey) headers.Authorization = `Bearer ${resolved.apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: resolved.modelId,
      messages: [
        { role: 'system', content: options.system },
        { role: 'user', content: options.prompt },
      ],
      stream: false,
    }),
    signal: options.signal,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw {
      kind: 'provider-error',
      status: response.status,
      message: `the LLM endpoint returned ${response.status}${body ? `: ${body.slice(0, MAX_ERROR_BODY)}` : ''}`,
    } satisfies CompleteOnceError;
  }
  const parsed = parseExternalPayload(
    chatResponseSchema,
    await response.json(),
    'chat completion response',
  );
  if (!parsed.ok) throw new Error(parsed.error);
  if (parsed.value.error) throw new Error(parsed.value.error.message ?? 'Completion failed');
  return parsed.value.choices?.[0]?.message.content ?? '';
}

/** One completion, no tools. Answers the assistant's text (possibly empty). */
export function completeOnce(options: CompleteOnceOptions): ResultAsync<string, CompleteOnceError> {
  const apiKey = options.apiKey || undefined;
  if (KEYED_PROVIDERS.has(options.provider) && !apiKey) {
    return errAsync({ kind: 'missing-credentials', provider: options.provider });
  }
  if (options.signal?.aborted) {
    return errAsync(toError(options.signal.reason, options.signal));
  }
  return ResultAsync.fromPromise(post(options, apiKey), (error) => toError(error, options.signal));
}

/** `typeof value === 'object'` without null; keeps `any` as `any`. */
function isObject<T>(value: T): value is T & object {
  return typeof value === 'object' && value !== null;
}
