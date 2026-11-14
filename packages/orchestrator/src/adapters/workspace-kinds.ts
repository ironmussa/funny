/**
 * The workspace provider of a factory: each request goes to the provider of
 * its project's workspace kind, and only there. A sandbox project never falls
 * back to a worktree (#289): a sandbox that fails is an infrastructure failure.
 */

import { errAsync, okAsync } from 'neverthrow';

import type { WorkspaceProvider, WorkspaceRequest } from '../ports/workspaces.js';

export function workspacesByKind(kinds: {
  worktree: WorkspaceProvider;
  /** Absent when no project uses a sandbox. */
  sandbox: WorkspaceProvider | null;
}): WorkspaceProvider {
  const missing = 'no sandbox provider is configured (settings: sandbox)';
  const of = (request: WorkspaceRequest) =>
    request.kind === 'worktree' ? kinds.worktree : kinds.sandbox;
  return {
    prepare: (request) => of(request)?.prepare(request) ?? errAsync(missing),
    reopen: (request) => of(request)?.reopen(request) ?? errAsync(missing),
    remove: (request) => of(request)?.remove(request) ?? errAsync(missing),
    discard: (request) => of(request)?.discard(request) ?? okAsync(undefined),
    exists: (request) => of(request)?.exists(request) ?? false,
    stopLeftovers: async (request) => {
      await of(request)?.stopLeftovers(request);
    },
    lastSessionId: async (request) => of(request)?.lastSessionId(request),
  };
}
