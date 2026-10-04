/**
 * Server → runner request helpers, and the one path that creates a thread on a
 * user's runner.
 *
 * `startThreadOnRunner` is used by the interactive `POST /api/threads` route
 * and by server-initiated work (automations), so runner isolation, the
 * project ↔ runner binding, and identity signing are enforced in one place.
 *
 * @domain subdomain: Runner Orchestration
 * @domain type: app-service
 * @domain layer: application
 */

import {
  NONCE_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  signForwardedIdentity,
} from '@funny/shared/auth/forwarded-identity';
import { parseStoredJson } from '@funny/shared/json-validation';
import { err, ok, type Result } from 'neverthrow';
import { z } from 'zod';

import { log } from '../lib/logger.js';
import { findRunnerForProject } from './runner-manager.js';
import type { RunnerPresencePort, RunnerRequestPort } from './runner-ports.js';
import * as runnerResolver from './runner-resolver.js';
import type { ResolvedRunner } from './runner-resolver.js';
import * as threadRegistry from './thread-registry.js';

const runnerErrorBodySchema = z.object({ error: z.string().optional() }).passthrough();

// Read at call time, not module load — the test harness sets this in a
// per-file top-of-module assignment, but this module may have already been
// imported by an earlier test file via the shared test-app helper, so
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

export interface RunnerPorts {
  requests: RunnerRequestPort;
  presence?: RunnerPresencePort;
}

export interface StartThreadInput {
  /** The user the thread belongs to and whose runner it must run on. */
  userId: string;
  orgId?: string;
  role?: string;
  orgName?: string;
  /** Request body for the runner's thread-creation endpoint (already validated). */
  body: Record<string, unknown>;
  /** `null` for scratch threads. */
  projectId: string | null;
  isScratch?: boolean;
  /** Runner endpoint. Defaults to `/api/threads` (create + start). */
  runnerPath?: string;
}

export type StartThreadError =
  | { kind: 'runner-unavailable'; status: 502; message: string }
  | { kind: 'runner-error'; status: number; message: string };

export interface StartedThread {
  /** The runner's response body (the created thread). */
  thread: any;
  threadId: string | undefined;
  runnerId: string;
}

/**
 * Create (and, on `/api/threads`, start) a thread on `userId`'s runner and
 * register it on the server. Never falls back to another user's runner.
 */
export async function startThreadOnRunner(
  input: StartThreadInput,
  ports: RunnerPorts,
): Promise<Result<StartedThread, StartThreadError>> {
  const { userId, body, projectId, isScratch = false } = input;
  const runnerPath = input.runnerPath ?? '/api/threads';

  // Scratch threads have no project, so ask for any reachable runner of this user.
  const resolved = isScratch
    ? await runnerResolver.resolveRunner(runnerPath, {}, userId, ports.presence)
    : await resolveRunnerForProject(projectId!, userId, ports.presence);
  if (!resolved) {
    return err({
      kind: 'runner-unavailable',
      status: 502,
      message: isScratch
        ? 'No online runner found for this user'
        : 'No online runner found for this project',
    });
  }

  try {
    const headers = buildForwardHeaders(userId, input.orgId, input.role, input.orgName);
    const result = await fetchFromRunner(ports.requests, resolved, runnerPath, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!result.ok) {
      return err({
        kind: 'runner-error',
        status: result.status,
        message: runnerErrorMessage(result.body),
      });
    }

    const threadData = JSON.parse(result.body);
    const threadId: string | undefined = threadData.id || threadData.thread?.id;
    if (threadId && resolved.runnerId !== '__default__') {
      await threadRegistry.registerThread({
        id: threadId,
        projectId,
        runnerId: resolved.runnerId,
        userId,
        title: typeof body.title === 'string' && body.title ? body.title : threadData.title,
        model: typeof body.model === 'string' ? body.model : undefined,
        mode: typeof body.mode === 'string' ? body.mode : undefined,
        // Use runtime response data — the runtime generates the worktree
        // branch name, so body.branch is typically undefined for new threads.
        branch:
          threadData.branch ??
          (typeof body.branch === 'string' && body.branch ? body.branch : undefined),
        isScratch,
      });
      runnerResolver.cacheThreadRunner(threadId, userId, resolved.runnerId);
    }

    return ok({ thread: threadData, threadId, runnerId: resolved.runnerId });
  } catch (e) {
    log.error('Failed to create thread on runner', {
      namespace: 'threads',
      error: (e as Error).message ?? String(e),
      stack: (e as Error).stack,
      path: runnerPath,
    });
    return err({ kind: 'runner-error', status: 502, message: 'Thread creation failed' });
  }
}
