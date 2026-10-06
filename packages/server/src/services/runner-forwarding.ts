/**
 * Runner forwarding helpers shared by thread routes and the threads module's
 * infrastructure adapters: user-scoped project→runner resolution, signed
 * identity headers, the request wrapper, and runner error-message extraction.
 */

import {
  NONCE_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  signForwardedIdentity,
} from '@funny/shared/auth/forwarded-identity';
import { parseStoredJson } from '@funny/shared/json-validation';
import { z } from 'zod';

import { findRunnerForProject } from './runner-manager.js';
import type { RunnerPresencePort, RunnerRequestPort } from './runner-ports.js';
import * as runnerResolver from './runner-resolver.js';
import type { ResolvedRunner } from './runner-resolver.js';

const runnerErrorBodySchema = z.object({ error: z.string().optional() }).passthrough();

// Read at call time, not module load — the test harness sets this in a
// per-file top-of-module assignment, but this module may have already
// been imported by an earlier test file via the shared test-app helper, so
// capturing it as a top-level constant freezes whatever value `process.env`
// happened to hold at first load (commonly undefined → crypto signing throws).
function getRunnerAuthSecret(): string {
  return process.env.RUNNER_AUTH_SECRET ?? '';
}

export async function resolveRunnerForProject(
  projectId: string,
  userId?: string,
  presence?: RunnerPresencePort,
): Promise<ResolvedRunner | null> {
  // CRITICAL (runner isolation): scope the project→runner lookup to the
  // requesting user. Without userId, findRunnerForProject returns ANY runner
  // assigned to the project — including another user's runner — which then gets
  // cached as the thread's runner and routes every request cross-tenant (the
  // server's data-handler correctly refuses, breaking the thread). A
  // collaborator must run on THEIR OWN runner.
  const runnerResult = await findRunnerForProject(projectId, userId);
  if (runnerResult && presence?.isAvailable(runnerResult.runner.runnerId)) {
    return { runnerId: runnerResult.runner.runnerId };
  }
  return await runnerResolver.resolveRunner('/api/threads', { projectId }, userId, presence);
}

export async function fetchFromRunner(
  requests: RunnerRequestPort,
  resolved: ResolvedRunner,
  path: string,
  opts: { method: string; headers: Record<string, string>; body?: string },
): Promise<{ ok: boolean; status: number; body: string }> {
  const resp = await requests.request(resolved.runnerId, {
    method: opts.method,
    path,
    headers: opts.headers,
    body: opts.body ?? null,
  });
  return {
    ok: resp.status >= 200 && resp.status < 400,
    status: resp.status,
    body: resp.body ?? '',
  };
}

export function buildForwardHeaders(
  userId: string,
  orgId?: string,
  role?: string,
  orgName?: string,
): Record<string, string> {
  // Default role to 'user' so the signed payload matches what the runtime
  // verifies (runtime defaults a missing X-Forwarded-Role to 'user' too).
  const effectiveRole = role ?? 'user';
  const runnerAuthSecret = getRunnerAuthSecret();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Forwarded-User': userId,
    'X-Runner-Auth': runnerAuthSecret,
    'X-Forwarded-Role': effectiveRole,
  };
  if (orgId) headers['X-Forwarded-Org'] = orgId;
  if (orgName) headers['X-Forwarded-Org-Name'] = orgName;
  const { signature, timestamp, nonce } = signForwardedIdentity(
    { userId, role: effectiveRole, orgId: orgId ?? null, orgName: orgName ?? null },
    runnerAuthSecret,
  );
  headers[SIGNATURE_HEADER] = signature;
  headers[TIMESTAMP_HEADER] = String(timestamp);
  headers[NONCE_HEADER] = nonce;
  return headers;
}

export function runnerErrorMessage(body: string): string {
  const parsed = parseStoredJson(runnerErrorBodySchema, body, 'runner error response');
  if (parsed.ok && parsed.value.error?.trim()) return parsed.value.error;
  return body.trim() || 'Runner request failed';
}
