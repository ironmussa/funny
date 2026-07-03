/**
 * Reap leaked agent processes orphaned by a FULL runtime restart.
 *
 * Why this exists
 * ───────────────
 * The dev runtime runs under `bun --watch`. On an IN-PROCESS hot-reload, active
 * ACP agents are intentionally preserved across the reload via
 * `globalThis.__funnyActiveAgentSnapshot` and re-adopted by the next instance
 * (see agent-lifecycle.adoptSurvivingProcesses). That handoff only works while
 * `globalThis` survives — i.e. an in-process reload (same OS process / PID).
 *
 * When bun instead does a FULL process restart (crash, uncaughtException, hard
 * `--watch` restart), `globalThis` is empty, the snapshot is lost, and the
 * preserved agent processes orphan (reparented to PID 1 / `systemd --user`).
 * Nothing reaps them, the new instance spawns fresh agents, and `codex-acp`
 * processes pile up until they saturate the machine (the laptop-freeze bug).
 *
 * The fix
 * ───────
 * Every agent funny spawns is tagged with `FUNNY_AGENT_OWNER=<runtime pid>`
 * (see `buildAgentChildEnv`, used at every agent spawn site). On startup we scan
 * for tagged agents whose owner runtime PID is no longer alive and kill their
 * process group. The owner tag means we:
 *   • never touch a `codex-acp` the user launched directly (e.g. in their editor)
 *     — it carries no tag;
 *   • never touch agents owned by a still-running funny instance — its PID is
 *     alive, so they are kept;
 *   • survive any reparenting (PID 1 vs `systemd --user`) since we key on the
 *     owner PID, not on the current parent.
 *
 * Linux-only (relies on `/proc`). No-ops on platforms without `/proc`
 * (macOS/Windows); a cross-platform reaper can be added later.
 */
import { readdirSync, readFileSync } from 'node:fs';

/** Env var stamped on every funny-spawned agent, holding the owner runtime PID. */
export const AGENT_OWNER_ENV = 'FUNNY_AGENT_OWNER';

/**
 * Build the child `env` for an agent spawn, stamped with the owner runtime PID
 * so a later instance can identify and reap it if this runtime dies. Use this at
 * EVERY agent spawn site instead of an ad-hoc `{ ...process.env, ...extra }`.
 */
export function buildAgentChildEnv(
  extra?: NodeJS.ProcessEnv,
  ownerPid: number = process.pid,
): NodeJS.ProcessEnv {
  return { ...process.env, ...extra, [AGENT_OWNER_ENV]: String(ownerPid) };
}

export interface ProcEntry {
  /** The process id. */
  pid: number;
  /** Process-group id (field `pgrp` from /proc/<pid>/stat). */
  pgrp: number;
  /** Owner runtime PID parsed from the FUNNY_AGENT_OWNER env var. */
  ownerPid: number;
}

/**
 * Pure decision: of the tagged agent processes, which process groups should be
 * reaped. We group by `pgrp` instead of requiring `pid === pgrp` because the
 * process-group leader can exit before its children (observed with codex-acp's
 * node wrapper), leaving live tagged children in an orphaned group. Killing the
 * negative process-group id still reaps the whole tree exactly once.
 *
 * A process group is reaped only when none of its tagged members belong to a
 * live owner runtime. This avoids killing a currently adopted group if a stale
 * tagged descendant somehow shares its process group.
 */
export function selectReapablePids(
  entries: ProcEntry[],
  isAlive: (pid: number) => boolean,
): number[] {
  const groups = new Map<number, { hasLiveOwner: boolean }>();
  for (const e of entries) {
    const group = groups.get(e.pgrp) ?? { hasLiveOwner: false };
    group.hasLiveOwner ||= isAlive(e.ownerPid);
    groups.set(e.pgrp, group);
  }
  const reap: number[] = [];
  for (const [pgrp, group] of groups) {
    if (!group.hasLiveOwner) reap.push(pgrp);
  }
  reap.sort((a, b) => a - b);
  return reap;
}

/** Parse the owner PID out of a NUL-separated /proc/<pid>/environ blob. */
export function parseOwnerFromEnviron(environ: string): number | null {
  const prefix = `${AGENT_OWNER_ENV}=`;
  for (const kv of environ.split('\0')) {
    if (kv.startsWith(prefix)) {
      const v = Number(kv.slice(prefix.length));
      return Number.isInteger(v) && v > 0 ? v : null;
    }
  }
  return null;
}

/**
 * Parse the `pgrp` field from a /proc/<pid>/stat line. The `comm` field can
 * contain spaces and parentheses, so we parse the fields AFTER the final ')':
 * they are `state ppid pgrp ...`, i.e. pgrp is index 2.
 */
export function parsePgrpFromStat(stat: string): number | null {
  const rparen = stat.lastIndexOf(')');
  if (rparen < 0) return null;
  const fields = stat
    .slice(rparen + 2)
    .trim()
    .split(/\s+/);
  const pgrp = Number(fields[2]);
  return Number.isInteger(pgrp) ? pgrp : null;
}

/** Does a PID exist? `kill(pid, 0)` throws ESRCH when gone, EPERM when alive-but-not-ours. */
function pidIsAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/** SIGTERM the process group, escalating to SIGKILL after `graceMs`. */
function killProcessGroup(pgrp: number, graceMs = 3000): void {
  const signalGroup = (sig: NodeJS.Signals): boolean => {
    try {
      process.kill(-pgrp, sig);
      return true;
    } catch {
      return false;
    }
  };
  signalGroup('SIGTERM');
  const timer = setTimeout(() => {
    signalGroup('SIGKILL');
  }, graceMs);
  timer.unref?.();
}

/** Collect tagged agent processes from /proc. Returns [] off-Linux. */
function scanProcEntries(): ProcEntry[] {
  let names: string[];
  try {
    names = readdirSync('/proc');
  } catch {
    return []; // no /proc (macOS/Windows) → reaper is a no-op
  }
  const entries: ProcEntry[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    let ownerPid: number | null;
    try {
      ownerPid = parseOwnerFromEnviron(readFileSync(`/proc/${pid}/environ`, 'utf8'));
    } catch {
      continue; // process vanished or environ unreadable
    }
    if (ownerPid == null) continue; // not a funny-spawned agent
    let pgrp: number | null;
    try {
      pgrp = parsePgrpFromStat(readFileSync(`/proc/${pid}/stat`, 'utf8'));
    } catch {
      continue;
    }
    if (pgrp == null) continue;
    entries.push({ pid, pgrp, ownerPid });
  }
  return entries;
}

/**
 * Reap funny-spawned agents whose owner runtime has died. Safe to call on every
 * startup: agents owned by THIS (alive) process or any other running funny
 * instance are kept; only genuinely-orphaned process groups are killed.
 *
 * @returns the number of agent process groups reaped.
 */
export function reapOrphanedAgents(onReap?: (pids: number[]) => void): number {
  if (process.platform === 'win32') return 0;
  const reapable = selectReapablePids(scanProcEntries(), pidIsAlive);
  for (const pgrp of reapable) killProcessGroup(pgrp);
  if (reapable.length > 0) onReap?.(reapable);
  return reapable.length;
}
