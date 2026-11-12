/**
 * Calls the `threads` tRPC procedures the way a client does: a query is
 * `GET /api/trpc/threads.<name>?input=<json>`, a mutation a `POST` with a JSON
 * body. Lists, detail, messages and field updates have no REST route.
 */
import type { TestApp } from './test-app.js';

export interface ProcedureAnswer {
  status: number;
  /** The procedure's result; `undefined` when it failed. */
  data: any;
  /** The error message; `undefined` when it succeeded. */
  error: string | undefined;
  /** The result, or `{ error }` when the call failed. */
  json(): Promise<any>;
}

async function answerOf(res: Response): Promise<ProcedureAnswer> {
  const body = (await res.json()) as any;
  const data = body?.result?.data;
  const error: string | undefined = body?.error?.message;
  return {
    status: res.status,
    data,
    error,
    json: async () => (error === undefined ? data : { error }),
  };
}

export function threadProcedures(
  t: Pick<TestApp, 'app'>,
  userId: string,
  extras?: { orgId?: string },
) {
  const headers = {
    'X-Test-User-Id': userId,
    'Content-Type': 'application/json',
    ...(extras?.orgId ? { 'X-Test-Org-Id': extras.orgId } : {}),
  };
  return {
    async query(name: string, input?: unknown): Promise<ProcedureAnswer> {
      const qs = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`;
      return answerOf(await t.app.request(`/api/trpc/threads.${name}${qs}`, { headers }));
    },
    async mutate(name: string, input: unknown): Promise<ProcedureAnswer> {
      return answerOf(
        await t.app.request(`/api/trpc/threads.${name}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(input),
        }),
      );
    },
  };
}
