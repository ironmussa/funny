/**
 * `@funny/api` — the tRPC router for the operations the central server answers
 * itself (openspec change `adopt-trpc-browser-api`).
 *
 * Clients import only `type AppRouter` from this entry (a value import would run
 * `initTRPC` in the browser, which throws) and `TRPC_PATH` from `@funny/api/path`
 * (`fitness:trpc-api`). The server mounts `appRouter` with a
 * context whose `ports` it implements. This package may import only browser-safe
 * `@funny/shared` modules, `@trpc/server`, `zod` and `neverthrow`
 * (`scripts/fitness/check-trpc-api.ts`).
 */

import { automationsRouter } from './routers/automations.js';
import { pipelinesRouter } from './routers/pipelines.js';
import { profileRouter } from './routers/profile.js';
import { settingsRouter } from './routers/settings.js';
import { threadsRouter } from './routers/threads.js';
import { router } from './trpc.js';

export const appRouter = router({
  automations: automationsRouter,
  pipelines: pipelinesRouter,
  threads: threadsRouter,
  profile: profileRouter,
  settings: settingsRouter,
});

export type AppRouter = typeof appRouter;

export { TRPC_PATH } from './path.js';

export {
  ApiFailureCause,
  codeForStatus,
  failure,
  failureFromDomainError,
  unwrap,
} from './failure.js';
export type { ApiFailure } from './failure.js';
export type {
  ApiCaller,
  ApiPorts,
  AuthzPort,
  AutomationsPort,
  PipelinesPort,
  ProfilePort,
  PortResult,
  SettingsPort,
  ThreadAccessLevel,
  ThreadAccessPort,
  ThreadsPort,
} from './ports.js';
export type { ApiContext } from './trpc.js';
