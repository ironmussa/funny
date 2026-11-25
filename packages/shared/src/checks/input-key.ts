/**
 * A stable key for a `funny_run_checks` call's input, so the client can match
 * the runner's `agent:check_run` event to the tool call it belongs to while the
 * call is still running (the tool cannot know the provider's tool-call id).
 * Both sides compute it from the input the agent sent.
 */

import type { JsonValue } from '../json.js';

const FIELDS = ['kind', 'scope', 'filter', 'command', 'background'] as const;

/** A `funny_run_checks` input as JSON; only `FIELDS` count toward the key. */
type CheckKeyInput = { readonly [field: string]: JsonValue | undefined };

/** The input's known fields, in a fixed order, without empty values. */
function canonical(input: CheckKeyInput): string {
  const picked = FIELDS.flatMap((field) => {
    const value = input[field];
    if (value === undefined || value === null || value === '' || value === false) return [];
    if (Array.isArray(value) && value.length === 0) return [];
    return [[field, value]];
  });
  return JSON.stringify(picked);
}

/** FNV-1a (32-bit) of the canonical input, as hex. */
export function checkInputKey(input: CheckKeyInput): string {
  let hash = 0x811c9dc5;
  for (const char of canonical(input)) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
