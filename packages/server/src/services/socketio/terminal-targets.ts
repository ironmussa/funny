import { z } from 'zod';

import type { RunnerTarget } from '../runner-access/index.js';

/**
 * Where a terminal runs. Only `pty:spawn` names its project or sandbox
 * thread; every later op (write, resize, restore, …) carries just the
 * terminal id. The spawn's target is remembered here so those ops reach the
 * same runner, re-certified each time by `withRunnerFor`, instead of whatever
 * projectless runner the user has — a sandbox terminal lives on the sandbox's
 * own runner.
 */
const targets = new Map<string, RunnerTarget>();

function key(userId: string, terminalId: string): string {
  return `${userId}\0${terminalId}`;
}

/** A terminal op as both browser carriers see it. */
export interface TerminalOp {
  type: string;
  id?: unknown;
  projectId?: unknown;
  sandboxThreadId?: unknown;
}

/** How an op is routed: the target to certify, and what to record once it is dispatched. */
export interface TerminalRoute {
  target: RunnerTarget;
  dispatched(): void;
}

/** A non-empty string field of an op; anything else reads as absent. */
const opText = z.string().min(1).optional().catch(undefined);

/** The routing fields of a terminal op, parsed from what the browser sent. */
const terminalOpRoutingSchema = z.object({
  id: opText,
  projectId: opText,
  sandboxThreadId: opText,
});

/** Target of a spawn: the sandbox thread's runner, the project's checkout, or projectless. */
function spawnTarget(projectId: string | null, sandboxThreadId: string | null): RunnerTarget {
  if (sandboxThreadId) {
    // The thread route resolves to the thread's sandbox runner only — never
    // the project's runner (see `runner-resolver.targetForThread`).
    return {
      kind: 'request',
      path: `/api/threads/${encodeURIComponent(sandboxThreadId)}`,
      query: {},
    };
  }
  return projectId ? { kind: 'project-checkout', projectId } : { kind: 'projectless' };
}

export function terminalRoute(userId: string, op: TerminalOp): TerminalRoute {
  const fields = terminalOpRoutingSchema.parse(op);
  const terminalId = fields.id ?? null;
  const terminalKey = terminalId ? key(userId, terminalId) : null;
  const projectId = fields.projectId ?? null;
  if (op.type === 'pty:spawn') {
    const target = spawnTarget(projectId, fields.sandboxThreadId ?? null);
    const remember = () => {
      if (terminalKey) targets.set(terminalKey, target);
    };
    return { target, dispatched: remember };
  }
  // Unknown (e.g. after a server restart): the op's own project, else projectless.
  const target = (terminalKey && targets.get(terminalKey)) || spawnTarget(projectId, null);
  const closes = op.type === 'pty:close' || op.type === 'pty:kill';
  const forget = () => {
    if (closes && terminalKey) targets.delete(terminalKey);
  };
  return { target, dispatched: forget };
}

/** The distinct routes of a user's open terminals, e.g. a sandbox thread's. */
export function terminalRoutesOf(userId: string): RunnerTarget[] {
  const prefix = `${userId}\0`;
  const routes = new Map<string, RunnerTarget>();
  for (const [terminalKey, target] of targets) {
    if (terminalKey.startsWith(prefix)) routes.set(JSON.stringify(target), target);
  }
  return [...routes.values()];
}
