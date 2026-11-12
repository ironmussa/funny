import { describe, expect, test } from 'bun:test';

import { findApiViolations, findClientViolations } from './check-trpc-api';

describe('fitness:trpc-api — @funny/api isolation', () => {
  test.each([
    "import { z } from 'zod';",
    "import { initTRPC } from '@trpc/server';",
    "import type { TRPC_ERROR_CODE_KEY } from '@trpc/server/rpc';",
    "import { unwrap } from '../failure.js';",
    "import type { Automation } from '@funny/shared';",
    "import { x } from '@funny/shared/contracts/automations';",
    "// import { db } from '@funny/server/db';",
  ])('allows %s', (source) => {
    expect(findApiViolations('x.ts', source)).toEqual([]);
  });

  test.each([
    ["import { db } from '@funny/server/db';", '@funny/server/db'],
    ["import { schema } from '@funny/shared/db/schema';", '@funny/shared/db/schema'],
    ["import { Database } from 'bun:sqlite';", 'bun:sqlite'],
    ["import { readFileSync } from 'node:fs';", 'node:fs'],
    ["export { gitRead } from '@funny/core/git';", '@funny/core/git'],
    ["const m = await import('@funny/runtime');", '@funny/runtime'],
    ["import 'hono';", 'hono'],
  ])('rejects %s', (source, specifier) => {
    expect(findApiViolations('routers/x.ts', source)).toEqual([
      `[api imports ${specifier}] packages/api/src/routers/x.ts:1`,
    ]);
  });
});

describe('fitness:trpc-api — web client', () => {
  test.each([
    "import type { AppRouter } from '@funny/api';",
    "import type {\n  AppRouter,\n} from '@funny/api';",
    "import { TRPC_PATH } from '@funny/api/path';",
    'trpcCall(() => trpc.automations.list.query())',
    "request('/automations-legacy')",
    "request('/pipelines-x')",
    'request(`/pipelines/approvals/${id}/respond`, { method: "POST" })',
    "request('/pipelines/approvals/pending')",
    "// request('/automations')",
    'request(`/threads/${threadId}/stop`, { method: "POST" })',
    'request(`/threads/${threadId}`, { method: "DELETE" })',
    "request('/profiles')",
    'request(`/jobs/${id}/cancel`, { method: "POST" })',
    'request(`/jobs/${id}/log?offset=0`)',
  ])('allows %s', (source) => {
    expect(findClientViolations('x.ts', source)).toEqual([]);
  });

  test('rejects a runtime import of the @funny/api entry, even across lines', () => {
    const source = "import {\n  TRPC_PATH,\n  type AppRouter,\n} from '@funny/api';";
    expect(findClientViolations('lib/x.ts', source)).toEqual([
      '[runtime import of @funny/api; use `import type` or @funny/api/path] packages/client/src/lib/x.ts:4',
    ]);
  });

  test.each([
    "request<Automation[]>('/automations')",
    'request(`/automations/${id}/runs`)',
    "requestInThread('/automations?projectId=p1')",
    'callEndpoint(automationsContract.list)',
    "request('/pipelines/project/p1')",
    'request(`/pipelines/${id}`, { method: "PATCH" })',
    'callEndpoint(pipelinesContract.get)',
    'callEndpoint(threadsContract.list)',
    "request<UserProfile>('/profile')",
    "request('/profile/runner-invite-token/rotate', { method: 'POST' })",
    'request(`/settings/agent-profiles/${id}`)',
    "request('/settings/smtp')",
    "request<Job[]>('/jobs')",
    'request(`/watchers/${id}/cancel`, { method: "POST" })',
    "request('/agent-templates/stats/usage')",
    'request(`/designs/${id}`)',
    'request<any>(`/analytics/overview?${qs}`)',
    "request('/push/config')",
    "request('/settings/github-app')",
    'request(`/runners/${runnerId}`, { method: "DELETE" })',
  ])('rejects REST use of a migrated group: %s', (source) => {
    expect(findClientViolations('x.ts', source)).toHaveLength(1);
  });
});
