/**
 * The factory's state: its runs and how many it started each day. It lives
 * in the user's home and survives restarts (reconciled against GitHub and the
 * workspaces on start, in a later change).
 */

export interface FactoryRun {
  id: string;
  /** `owner/name`. */
  repo: string;
  issueNumber: number;
  /** A state of the run state machine (`queued`, `working`, `waiting_ci`, `failed`, …). */
  state: string;
  prUrl: string | null;
  /** Why the run waits or failed, for `status`. */
  reason: string | null;
  /** ISO 8601. */
  createdAt: string;
  updatedAt: string;
}

export interface RunStore {
  /** Every run, newest first. */
  list(): FactoryRun[];
  /** Insert or replace a run. */
  save(run: FactoryRun): void;
  /** Runs started on `day` (`YYYY-MM-DD`, UTC). */
  startedOn(day: string): number;
  /** Count one more run started on `day`. */
  recordStart(day: string): void;
  close(): void;
}
