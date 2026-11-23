/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * The shared shape of the git routes that act on a checkout: resolve the
 * caller's checkout of the route's project or thread, read and validate the
 * body, and for a mutation keep its file paths inside the checkout, run the
 * operation, drop the cached git status and answer.
 */

import type { DomainError } from '@funny/shared/errors';
import type { Context, Hono } from 'hono';
import { err, ok, type Result } from 'neverthrow';
import type { z } from 'zod';

import { requestSpan } from '../../middleware/tracing.js';
import { validateFilePaths } from '../../services/git-service.js';
import type { HonoEnv } from '../../types/hono-env.js';
import { resultToResponse } from '../../utils/result-response.js';
import { requireThreadCwd, steerFromContext } from '../../utils/route-helpers.js';
import { readBody, requirePathQuery } from '../../validation/request.js';
import { gitStatusCache, invalidateGitStatusCache, requireProjectCwd } from './helpers.js';

/** Who asks, and the checkout the operation runs in. */
export interface GitTarget {
  userId: string;
  cwd: string;
}

export interface ProjectGitTarget extends GitTarget {
  projectId: string;
}

export interface ThreadGitTarget extends GitTarget {
  threadId: string;
}

export interface GitMutation<Target extends GitTarget, Body, Value> {
  /** Schema of the JSON body; omit it for a route that reads none. */
  body?: z.ZodType<Body>;
  /** The body's file paths, which must stay inside the checkout. */
  paths?: (body: Body) => string[];
  run: (target: Target, body: Body) => PromiseLike<Result<Value, DomainError>>;
  /** The success fields besides `ok: true`; by default the result as `output`. */
  respond?: (value: Value) => object;
  /** Runs after the cached status is dropped (e.g. other caches the operation stales). */
  after?: (target: Target) => void;
}

/** `respond` for a route that answers only `{ ok: true }`, whatever the operation returns. */
export const okOnly = (): object => ({});

/** The caller's checkout of the route's `:projectId`. */
async function projectCheckout(
  c: Context<HonoEnv>,
): Promise<Result<ProjectGitTarget, DomainError>> {
  // SAFETY: only mounted on routes whose path declares :projectId.
  const projectId = c.req.param('projectId') as string;
  const userId = c.get('userId');
  const cwd = await requireProjectCwd(projectId, userId, c.get('organizationId'));
  return cwd.map((dir) => ({ projectId, userId, cwd: dir }));
}

/** The caller's checkout of the route's `:threadId`. */
async function threadCheckout(
  c: Context<HonoEnv>,
  steerable = false,
): Promise<Result<ThreadGitTarget, DomainError>> {
  // SAFETY: only mounted on routes whose path declares :threadId.
  const threadId = c.req.param('threadId') as string;
  const userId = c.get('userId');
  const cwd = await requireThreadCwd(threadId, userId, steerableGrant(c, steerable));
  return cwd.map((dir) => ({ threadId, userId, cwd: dir }));
}

/**
 * The steer-share claim, only for a route on the steer allow-list
 * (thread-sharing-steer): there the owner's checkout serves the sharee.
 */
function steerableGrant(c: Context<HonoEnv>, steerable: boolean) {
  return steerable ? steerFromContext(c) : undefined;
}

/** Runs `handler` in the caller's checkout of the route's `:projectId`, or answers why there is none. */
export async function withProjectCheckout(
  c: Context<HonoEnv>,
  handler: (target: ProjectGitTarget) => Response | Promise<Response>,
): Promise<Response> {
  return answerIn(c, await projectCheckout(c), handler);
}

/** Runs `handler` in the caller's checkout of the route's `:threadId`, or answers why there is none. */
export async function withThreadCheckout(
  c: Context<HonoEnv>,
  handler: (target: ThreadGitTarget) => Response | Promise<Response>,
  options: { steerable?: boolean } = {},
): Promise<Response> {
  return answerIn(c, await threadCheckout(c, options.steerable), handler);
}

function answerIn<Target>(
  c: Context<HonoEnv>,
  target: Result<Target, DomainError>,
  handler: (target: Target) => Response | Promise<Response>,
): Response | Promise<Response> {
  return target.isErr() ? resultToResponse(c, target) : handler(target.value);
}

/** A checkout of either kind, with the ids that name it in spans and logs. */
export interface Checkout extends GitTarget {
  ids: { projectId: string } | { threadId: string };
}

/**
 * Registers `handler` for the same git route on both kinds of checkout:
 * `/project/:projectId<path>` and `/:threadId<path>`. `steerable` admits a
 * steer sharee on the thread route: use it only for routes on the steer
 * allow-list.
 */
export function onBothCheckouts(
  routes: Hono<HonoEnv>,
  method: 'GET' | 'POST',
  path: string,
  handler: (c: Context<HonoEnv>, checkout: Checkout) => Response | Promise<Response>,
  options: { steerable?: boolean } = {},
): void {
  routes.on(method, `/project/:projectId${path}`, (c) =>
    withProjectCheckout(c, ({ projectId, userId, cwd }) =>
      handler(c, { userId, cwd, ids: { projectId } }),
    ),
  );
  routes.on(method, `/:threadId${path}`, (c) =>
    withThreadCheckout(
      c,
      ({ threadId, userId, cwd }) => handler(c, { userId, cwd, ids: { threadId } }),
      options,
    ),
  );
}

/** A git mutation on the route's `:projectId`, in the caller's checkout of that project. */
export async function projectGitMutation<Body = undefined, Value = unknown>(
  c: Context<HonoEnv>,
  mutation: GitMutation<ProjectGitTarget, Body, Value>,
): Promise<Response> {
  return runGitMutation(c, await projectCheckout(c), mutation, (t) => {
    gitStatusCache.delete(t.projectId);
  });
}

/** A git mutation on the route's `:threadId`, in that thread's checkout. */
export async function threadGitMutation<Body = undefined, Value = unknown>(
  c: Context<HonoEnv>,
  mutation: GitMutation<ThreadGitTarget, Body, Value>,
): Promise<Response> {
  return runGitMutation(c, await threadCheckout(c), mutation, (t) =>
    invalidateGitStatusCache(t.threadId),
  );
}

/** Answers `{ diff }` for the required `?path=` file, computed by `op` inside a span. */
export async function answerPathDiff(
  c: Context<HonoEnv>,
  spanName: string,
  attributes: Record<string, unknown>,
  op: (filePath: string) => PromiseLike<Result<string, DomainError>>,
): Promise<Response> {
  const filePath = requirePathQuery(c);
  if (filePath.isErr()) return resultToResponse(c, filePath);
  const result = await traced(c, spanName, { ...attributes, path: filePath.value }, () =>
    op(filePath.value),
  );
  return result.isErr() ? resultToResponse(c, result) : c.json({ diff: result.value });
}

/** Runs `op` inside a request span that ends with the result's outcome. */
export async function traced<Value>(
  c: Context<HonoEnv>,
  name: string,
  attributes: Record<string, unknown>,
  op: () => PromiseLike<Result<Value, DomainError>>,
): Promise<Result<Value, DomainError>> {
  const span = requestSpan(c, name, attributes);
  const result = await op();
  result.match(
    () => span.end('ok'),
    (error) => span.end('error', error.message),
  );
  return result;
}

async function runGitMutation<Target extends GitTarget, Body, Value>(
  c: Context<HonoEnv>,
  target: Result<Target, DomainError>,
  mutation: GitMutation<Target, Body, Value>,
  invalidate: (target: Target) => void | Promise<void>,
): Promise<Response> {
  const prepared = await prepareMutation(c, target, mutation);
  if (prepared.isErr()) return resultToResponse(c, prepared);
  const result = await mutation.run(prepared.value.target, prepared.value.body);
  if (result.isErr()) return resultToResponse(c, result);
  await invalidate(prepared.value.target);
  mutation.after?.(prepared.value.target);
  return c.json({ ok: true, ...successFields(mutation, result.value) });
}

/** The target and the validated body, or the first reason the request is refused. */
async function prepareMutation<Target extends GitTarget, Body, Value>(
  c: Context<HonoEnv>,
  target: Result<Target, DomainError>,
  mutation: GitMutation<Target, Body, Value>,
): Promise<Result<{ target: Target; body: Body }, DomainError>> {
  if (target.isErr()) return err(target.error);
  const body = await readBody(c, mutation.body);
  return body.andThen((value) =>
    checkPaths(target.value.cwd, mutation.paths, value).map(() => ({
      target: target.value,
      body: value,
    })),
  );
}

function checkPaths<Body>(
  cwd: string,
  paths: ((body: Body) => string[]) | undefined,
  body: Body,
): Result<void, DomainError> {
  return paths ? validateFilePaths(cwd, paths(body)) : ok(undefined);
}

function successFields<Target extends GitTarget, Body, Value>(
  mutation: GitMutation<Target, Body, Value>,
  value: Value,
): object {
  return mutation.respond ? mutation.respond(value) : { output: value };
}
