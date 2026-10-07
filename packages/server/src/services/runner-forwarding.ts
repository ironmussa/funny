/**
 * Runner error-message extraction for responses relayed from a runner.
 * Runner selection, identity signing and sends live in
 * `services/runner-access` (runner-request-isolation).
 */

import { parseStoredJson } from '@funny/shared/json-validation';
import { z } from 'zod';

const runnerErrorBodySchema = z.object({ error: z.string().optional() }).passthrough();

export function runnerErrorMessage(body: string): string {
  const parsed = parseStoredJson(runnerErrorBodySchema, body, 'runner error response');
  if (parsed.ok && parsed.value.error?.trim()) return parsed.value.error;
  return body.trim() || 'Runner request failed';
}
