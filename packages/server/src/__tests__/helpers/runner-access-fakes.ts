/**
 * Test doubles for `services/runner-access`. Production code never calls
 * `createRunnerAccess` outside that directory (fitness-checked); tests use it
 * to decide runner selection and ownership without a database.
 */
import {
  createRunnerAccess,
  type RunnerAccess,
  type RunnerTarget,
} from '../../services/runner-access/index.js';

export interface FakeRunnerAccessOptions {
  /** The runner selection returns for a user (null = none). Default: `runner-1`. May be async. */
  runnerFor?: (userId: string) => string | null | Promise<string | null>;
  /** Runner ownership. Default: every runner belongs to `user-1`. */
  owners?: Record<string, string | null>;
  /** Scope rule for project targets. Default: allowed. */
  allowProject?: (runnerId: string, projectId: string) => boolean;
  /** Scope rule for projectless targets. Default: allowed. */
  allowProjectless?: (runnerId: string) => boolean;
  /** Runner the identity-free OAuth callback selection returns. Default: `runner-1`. */
  oauthRunner?: string | null;
  /** Observes every selection (user id + target), for routing assertions. */
  onSelect?: (userId: string, target: RunnerTarget) => void;
}

export function fakeRunnerAccess(opts: FakeRunnerAccessOptions = {}): RunnerAccess {
  const runnerFor = opts.runnerFor ?? (() => 'runner-1');
  const owners = opts.owners ?? { 'runner-1': 'user-1' };
  const pick = async (userId: string, target: RunnerTarget) => {
    opts.onSelect?.(userId, target);
    return runnerFor(userId);
  };
  return createRunnerAccess({
    selection: {
      anyRunnerForUser: async (userId) => pick(userId, { kind: 'projectless' }),
      runnerForProject: async (projectId, userId) =>
        pick(userId, { kind: 'project-checkout', projectId }),
      resolveRequest: async (path, query, userId) => {
        const runnerId = await pick(userId, { kind: 'request', path, query });
        return runnerId
          ? { ok: true, runnerId }
          : { ok: false, reason: 'general-runner-offline' as const };
      },
      pinnedRunnerIdsForProject: async () => null,
      anyGeneralRunner: async () =>
        opts.oauthRunner === undefined ? 'runner-1' : opts.oauthRunner,
    },
    verification: {
      runnerOwner: async (runnerId) => owners[runnerId] ?? null,
      canAccessProject: async (runnerId, projectId) =>
        opts.allowProject?.(runnerId, projectId) ?? true,
      canServeProjectless: async (runnerId) => opts.allowProjectless?.(runnerId) ?? true,
      routeTarget: async () => ({ kind: 'projectless' }),
    },
  });
}
