import type { JsonObject } from '@funny/shared/json';

/**
 * Whether a value an agent sent us as JSON (an ACP JSON-RPC message, a model's
 * tool call arguments) is an object. Such a value came out of `JSON.parse`, so
 * every field it holds is JSON. An array passes too, like the
 * `typeof value === 'object'` checks this replaces; its indices read as keys.
 */
export function isJsonPayloadObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null;
}
