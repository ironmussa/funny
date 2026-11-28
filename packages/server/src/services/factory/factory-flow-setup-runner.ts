/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: infrastructure-adapter
 * @domain layer: infrastructure
 *
 * Server → runner requests for `factory-setup` threads (openspec
 * `factory-flow-bootstrap`, D4). Every request goes through the certified
 * runner sink (`withRunnerFor`), as the member who owns the setup thread —
 * never to another user's runner.
 */

import { testStackFactsSchema, type TestStackFacts } from '@funny/core';
import { parseStoredJson } from '@funny/shared/json-validation';
import {
  commitFlowSetupAnswerSchema,
  flowSetupFileAnswerSchema,
  openFlowSetupPRAnswerSchema,
  verifyFlowSetupPollAnswerSchema,
  verifyFlowSetupStartAnswerSchema,
  type commitFlowSetupSchema,
  type openFlowSetupPRSchema,
  type verifyFlowSetupSchema,
} from '@ironmussa/funny-runtime/validation/schemas';
import { err, ok, type Result } from 'neverthrow';
import { z } from 'zod';

import type { RunnerPorts } from '../runner-thread-launcher.js';
import { sendAsUser } from '../thread-runner-requests.js';
import {
  toVerifyFlowSetupResult,
  type VerifyFlowSetupResult,
} from './factory-flow-setup-schemas.js';
import { RUNNER_UNAVAILABLE_PREFIX } from './factory-runner-jobs.js';

export type { VerifyFlowSetupResult } from './factory-flow-setup-schemas.js';

export type VerifySetupJobBody = z.input<typeof verifyFlowSetupSchema>;
export type CommitSetupBody = z.input<typeof commitFlowSetupSchema>;
export type OpenSetupPRBody = z.input<typeof openFlowSetupPRSchema>;

export type CommitAndPushSetupResult = z.infer<typeof commitFlowSetupAnswerSchema>;
export type OpenSetupPRResult = z.infer<typeof openFlowSetupPRAnswerSchema>;

export interface SetupRunnerError {
  kind: 'runner-unavailable' | 'not-found' | 'runner-error';
  message: string;
}

interface ParsedRunnerErrorInfo {
  error?: string;
  code?: string;
}

const errorBodySchema = z.object({ error: z.string(), code: z.string().optional() }).passthrough();

function parseRunnerError(body: string | null | undefined): ParsedRunnerErrorInfo {
  if (!body) return {};
  const parsed = parseStoredJson(errorBodySchema, body, 'setup runner error');
  return parsed.ok ? { error: parsed.value.error.slice(0, 500), code: parsed.value.code } : {};
}

async function sendSetupRequest(
  ports: RunnerPorts,
  userId: string,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  options: { query?: Record<string, string>; body?: unknown } = {},
): Promise<Result<{ status: number; body: string | null }, SetupRunnerError>> {
  const hasBody = options.body !== undefined && options.body !== null;
  try {
    const sent = await sendAsUser(ports, userId, {
      method,
      path,
      query: options.query ?? {},
      queryInPath: true,
      headers: hasBody ? { 'Content-Type': 'application/json' } : {},
      body: hasBody ? JSON.stringify(options.body) : null,
    });
    return sent.mapErr((reason) => ({
      kind: 'runner-unavailable' as const,
      message: `${RUNNER_UNAVAILABLE_PREFIX}${reason}`,
    }));
  } catch (error) {
    return err({
      kind: 'runner-unavailable',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** A runner answer with no body to read: an error status is a runner error. */
function expectSuccess(
  sent: { status: number; body: string | null },
  opts: { notFoundOk?: boolean } = {},
): Result<void, SetupRunnerError> {
  if (sent.status < 400 || (opts.notFoundOk && sent.status === 404)) return ok(undefined);
  const info = parseRunnerError(sent.body);
  return err({
    kind: 'runner-error',
    message: `runner answered ${sent.status}${info.error ? `: ${info.error}` : ''}`,
  });
}

function decodeJson<TSchema extends z.ZodTypeAny>(
  sent: { status: number; body: string | null },
  schema: TSchema,
  label: string,
): Result<z.infer<TSchema>, SetupRunnerError> {
  if (sent.status === 404) {
    const info = parseRunnerError(sent.body);
    return err({
      kind: 'not-found',
      message: info.code ?? info.error ?? `${label} not found`,
    });
  }
  if (sent.status >= 400) {
    const info = parseRunnerError(sent.body);
    return err({
      kind: 'runner-error',
      message: `runner answered ${sent.status}${info.error ? `: ${info.error}` : ''}`,
    });
  }
  const parsed = parseStoredJson(schema, sent.body ?? '', label);
  if (!parsed.ok) return err({ kind: 'runner-error', message: parsed.error });
  return ok(parsed.value);
}

/** Decode the runner's poll answer and map a finished job to the contract's verdict shape. */
export function decodeVerifyPoll(sent: {
  status: number;
  body: string | null;
}): Result<
  { state: 'running' } | { state: 'done'; result: VerifyFlowSetupResult },
  SetupRunnerError
> {
  return decodeJson(sent, verifyFlowSetupPollAnswerSchema, 'verify poll response').map((answer) =>
    answer.state === 'done'
      ? { state: 'done' as const, result: toVerifyFlowSetupResult(answer.result) }
      : { state: 'running' as const },
  );
}

export interface FactoryFlowSetupRunnerClient {
  detectStack(userId: string, threadId: string): Promise<Result<TestStackFacts, SetupRunnerError>>;
  readSetupFile(
    userId: string,
    threadId: string,
    relPath: string,
  ): Promise<Result<{ path: string; content: string }, SetupRunnerError>>;
  sendFirstMessage(
    userId: string,
    threadId: string,
    content: string,
    expectedBranch: string,
  ): Promise<Result<void, SetupRunnerError>>;
  startVerify(
    userId: string,
    threadId: string,
    body: VerifySetupJobBody,
  ): Promise<Result<{ jobId: string; state: string }, SetupRunnerError>>;
  pollVerify(
    userId: string,
    threadId: string,
    jobId: string,
  ): Promise<
    Result<
      { state: 'running' } | { state: 'done'; result: VerifyFlowSetupResult },
      SetupRunnerError
    >
  >;
  cancelVerify(
    userId: string,
    threadId: string,
    jobId: string,
  ): Promise<Result<void, SetupRunnerError>>;
  commitAndPush(
    userId: string,
    threadId: string,
    body: CommitSetupBody,
  ): Promise<Result<CommitAndPushSetupResult, SetupRunnerError>>;
  openPullRequest(
    userId: string,
    threadId: string,
    body: OpenSetupPRBody,
  ): Promise<Result<OpenSetupPRResult, SetupRunnerError>>;
}

export function createFactoryFlowSetupRunnerClient(
  ports: RunnerPorts,
): FactoryFlowSetupRunnerClient {
  return {
    async detectStack(userId, threadId) {
      const sent = await sendSetupRequest(
        ports,
        userId,
        'POST',
        `/api/threads/${encodeURIComponent(threadId)}/factory-flow-setup/detect`,
      );
      return sent.andThen((v) => decodeJson(v, testStackFactsSchema, 'detect stack response'));
    },

    async readSetupFile(userId, threadId, relPath) {
      const sent = await sendSetupRequest(
        ports,
        userId,
        'GET',
        `/api/threads/${encodeURIComponent(threadId)}/factory-flow-setup/file`,
        { query: { path: relPath } },
      );
      return sent.andThen((v) => decodeJson(v, flowSetupFileAnswerSchema, 'setup file response'));
    },

    async sendFirstMessage(userId, threadId, content, expectedBranch) {
      const sent = await sendSetupRequest(
        ports,
        userId,
        'POST',
        `/api/threads/${encodeURIComponent(threadId)}/message`,
        { body: { content, expectedBranch } },
      );
      return sent.andThen((v) => expectSuccess(v));
    },

    async startVerify(userId, threadId, body) {
      const sent = await sendSetupRequest(
        ports,
        userId,
        'POST',
        `/api/threads/${encodeURIComponent(threadId)}/factory-flow-setup/verify`,
        { body },
      );
      return sent.andThen((v) =>
        decodeJson(v, verifyFlowSetupStartAnswerSchema, 'verify start response'),
      );
    },

    async pollVerify(userId, threadId, jobId) {
      const sent = await sendSetupRequest(
        ports,
        userId,
        'GET',
        `/api/threads/${encodeURIComponent(threadId)}/factory-flow-setup/verify/${encodeURIComponent(jobId)}`,
      );
      return sent.andThen((v) => decodeVerifyPoll(v));
    },

    async cancelVerify(userId, threadId, jobId) {
      const sent = await sendSetupRequest(
        ports,
        userId,
        'DELETE',
        `/api/threads/${encodeURIComponent(threadId)}/factory-flow-setup/verify/${encodeURIComponent(jobId)}`,
      );
      return sent.andThen((v) => expectSuccess(v, { notFoundOk: true }));
    },

    async commitAndPush(userId, threadId, body) {
      const sent = await sendSetupRequest(
        ports,
        userId,
        'POST',
        `/api/threads/${encodeURIComponent(threadId)}/factory-flow-setup/commit`,
        { body },
      );
      return sent.andThen((v) =>
        decodeJson(v, commitFlowSetupAnswerSchema, 'commit setup response'),
      );
    },

    async openPullRequest(userId, threadId, body) {
      const sent = await sendSetupRequest(
        ports,
        userId,
        'POST',
        `/api/threads/${encodeURIComponent(threadId)}/factory-flow-setup/pull-request`,
        { body },
      );
      return sent.andThen((v) =>
        decodeJson(v, openFlowSetupPRAnswerSchema, 'open setup PR response'),
      );
    },
  };
}
