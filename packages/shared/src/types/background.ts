// Agent watchers, agent jobs and background activities (re-exported from `../types.js`).
import type { JsonObject } from '../json.js';

// ─── Agent watchers (deferred-wake "snooze") ─────────────────────────────────

export type WatcherStatus = 'pending' | 'fired' | 'done' | 'cancelled' | 'expired';

export interface Watcher {
  id: string;
  threadId: string;
  userId: string;
  /** Stable dedupe key per logical thing the agent is watching. */
  key: string;
  label: string;
  /** Epoch-ms when the watcher next fires. */
  nextWakeAt: number;
  /** The most recent delay the agent requested, in ms (for display). */
  lastDelayMs: number;
  wakeCount: number;
  maxWakes: number;
  /** Epoch-ms hard lifetime ceiling; null = no deadline. */
  deadline: number | null;
  status: WatcherStatus;
  createdAt: string;
  updatedAt: string;
}

export interface WSWatcherData {
  watcher: Watcher;
}

// ─── Agent jobs (funny-owned detached background processes) ───────────────────

export type JobStatus = 'running' | 'exited' | 'failed' | 'killed' | 'cancelled';

export interface Job {
  id: string;
  threadId: string;
  userId: string;
  command: string;
  cwd: string | null;
  label: string | null;
  /** OS pid of the detached session leader; null until known. */
  pid: number | null;
  logPath: string;
  exitPath: string;
  status: JobStatus;
  exitCode: number | null;
  startedAt: string;
  updatedAt: string;
}

export interface JobLogChunk {
  output: string;
  offset: number;
  size: number;
  status: JobStatus;
  exitCode: number | null;
}

export interface WSJobData {
  job: Job;
}

// ─── Background activities (operations a user starts and actions funny takes on its own) ──

export type ActivityStatus = 'running' | 'succeeded' | 'failed' | 'interrupted';

/**
 * Who started an activity (track-funny-actions): the user asked for it, it
 * followed from another action of the user, or funny started it on its own.
 */
export type ActivityOrigin = 'user' | 'implicit' | 'system';

/** The things an activity can remove, stop or change (`ACTIVITY_EFFECTS`). */
export type ActivityEffectType =
  | 'worktree-removed'
  | 'branch-deleted'
  | 'command-stopped'
  | 'terminal-closed'
  | 'directory-removed'
  | 'branch-checked-out'
  | 'changes-stashed'
  | 'sandbox-stopped'
  | 'sandbox-destroyed'
  | 'pr-merged'
  | 'pr-closed'
  | 'remote-branch-deleted'
  | 'agent-stopped'
  | 'factory-disabled'
  | 'repo-published'
  | 'issue-deleted'
  | 'issue-labeled'
  | 'file-reverted'
  | 'changes-discarded'
  | 'commits-reset'
  | 'stash-dropped'
  | 'code-rewound'
  | 'snapshot-saved'
  | 'commit-created';

/** One thing an activity changed, with the name of the thing (a path, a branch, a PR). */
export interface ActivityEffect {
  effect: ActivityEffectType;
  target: string;
}

/** A reference to what a finished activity produced. */
export interface ActivityResultRef {
  projectId?: string;
  prUrl?: string;
  /** The undo snapshot the operation saved (`refs/funny/undo/<activity id>`). */
  snapshot?: string;
}

export interface Activity {
  id: string;
  userId: string;
  /** The runner that ran it; null for a server-run activity. */
  runnerId: string | null;
  /** A key of the kind registry (`@funny/shared/activities`). */
  kind: string;
  projectId: string | null;
  threadId: string | null;
  title: string;
  status: ActivityStatus;
  step: string | null;
  error: string | null;
  /** The kind's input, validated and stripped of undeclared fields. */
  input: JsonObject;
  resultRef: ActivityResultRef | null;
  origin: ActivityOrigin;
  /** What it removed, stopped or changed; null when it reported nothing. */
  effects: ActivityEffect[] | null;
  startedAt: string;
  endedAt: string | null;
}

export interface WSActivityUpdatedData {
  activity: Activity;
}

export interface WSActivityRemovedData {
  ids: string[];
}

/** Transient progress of a running activity; never persisted. */
export interface WSActivityProgressData {
  id: string;
  percent: number;
}
