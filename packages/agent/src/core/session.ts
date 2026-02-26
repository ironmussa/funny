/**
 * Session — tracks an issue through its full lifecycle from backlog to merged PR.
 *
 * Each session represents one issue being processed autonomously.
 * Uses a state machine for lifecycle transitions and maintains
 * a full audit trail of events.
 */

import { nanoid } from 'nanoid';

import { StateMachine } from './state-machine.js';

// ── Session Status ──────────────────────────────────────────────

export type SessionStatus =
  | 'created'
  | 'planning'
  | 'implementing'
  | 'quality_check'
  | 'pr_created'
  | 'ci_running'
  | 'ci_passed'
  | 'ci_failed'
  | 'review'
  | 'changes_requested'
  | 'merged'
  | 'failed'
  | 'escalated'
  | 'cancelled';

export const SESSION_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  created: ['planning', 'cancelled', 'failed'],
  planning: ['implementing', 'escalated', 'cancelled', 'failed'],
  implementing: ['quality_check', 'pr_created', 'escalated', 'cancelled', 'failed'],
  quality_check: ['pr_created', 'implementing', 'escalated', 'failed'],
  pr_created: ['ci_running', 'review', 'escalated', 'cancelled', 'failed'],
  ci_running: ['ci_passed', 'ci_failed', 'escalated', 'failed'],
  ci_passed: ['review', 'merged', 'escalated'],
  ci_failed: ['implementing', 'ci_running', 'escalated', 'failed'],
  review: ['changes_requested', 'merged', 'escalated'],
  changes_requested: ['implementing', 'ci_running', 'review', 'escalated', 'failed'],
  merged: [], // terminal
  failed: [], // terminal
  escalated: ['implementing', 'cancelled'], // can resume after human intervention
  cancelled: [], // terminal
};

// ── Session Event ───────────────────────────────────────────────

export interface SessionEvent {
  id: string;
  timestamp: string;
  type: string;
  data: Record<string, unknown>;
}

// ── Issue Reference ─────────────────────────────────────────────

export interface IssueRef {
  number: number;
  title: string;
  url: string;
  repo: string;
  body?: string;
  labels: string[];
}

// ── Implementation Plan ─────────────────────────────────────────

export interface ImplementationPlan {
  summary: string;
  approach: string;
  files_to_modify: string[];
  files_to_create: string[];
  estimated_complexity: 'small' | 'medium' | 'large';
  risks: string[];
  sub_tasks?: string[];
}

// ── Session Data ────────────────────────────────────────────────

export interface SessionData {
  id: string;
  status: SessionStatus;
  issue: IssueRef;
  plan: ImplementationPlan | null;
  projectPath: string;
  branch: string | null;
  worktreePath: string | null;
  threadId: string | null;
  prNumber: number | null;
  prUrl: string | null;

  // Retry tracking
  ciAttempts: number;
  reviewAttempts: number;

  // Timestamps
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;

  // Audit trail
  events: SessionEvent[];

  // Metadata
  model: string;
  provider: string;
  metadata: Record<string, unknown>;
}

// ── Session Class ───────────────────────────────────────────────

export class Session {
  private machine: StateMachine<SessionStatus>;
  private data: SessionData;

  constructor(
    issue: IssueRef,
    projectPath: string,
    opts?: {
      model?: string;
      provider?: string;
      metadata?: Record<string, unknown>;
    },
  ) {
    const now = new Date().toISOString();
    const id = `session-${nanoid(10)}`;

    this.data = {
      id,
      status: 'created',
      issue,
      plan: null,
      projectPath,
      branch: null,
      worktreePath: null,
      threadId: null,
      prNumber: null,
      prUrl: null,
      ciAttempts: 0,
      reviewAttempts: 0,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      events: [],
      model: opts?.model ?? 'claude-sonnet-4-5-20250929',
      provider: opts?.provider ?? 'funny-api-acp',
      metadata: opts?.metadata ?? {},
    };

    this.machine = new StateMachine(SESSION_TRANSITIONS, 'created', `session:${id}`);

    this.addEvent('session.created', { issueNumber: issue.number, issueTitle: issue.title });
  }

  // ── Static factory from serialized data ───────────────────────

  static fromData(data: SessionData): Session {
    const session = Object.create(Session.prototype) as Session;
    session.data = { ...data };
    session.machine = new StateMachine(SESSION_TRANSITIONS, data.status, `session:${data.id}`);
    return session;
  }

  // ── Getters ───────────────────────────────────────────────────

  get id(): string {
    return this.data.id;
  }
  get status(): SessionStatus {
    return this.data.status;
  }
  get issue(): IssueRef {
    return this.data.issue;
  }
  get plan(): ImplementationPlan | null {
    return this.data.plan;
  }
  get projectPath(): string {
    return this.data.projectPath;
  }
  get branch(): string | null {
    return this.data.branch;
  }
  get worktreePath(): string | null {
    return this.data.worktreePath;
  }
  get threadId(): string | null {
    return this.data.threadId;
  }
  get prNumber(): number | null {
    return this.data.prNumber;
  }
  get prUrl(): string | null {
    return this.data.prUrl;
  }
  get ciAttempts(): number {
    return this.data.ciAttempts;
  }
  get reviewAttempts(): number {
    return this.data.reviewAttempts;
  }
  get events(): readonly SessionEvent[] {
    return this.data.events;
  }
  get model(): string {
    return this.data.model;
  }
  get provider(): string {
    return this.data.provider;
  }
  get updatedAt(): string {
    return this.data.updatedAt;
  }
  get createdAt(): string {
    return this.data.createdAt;
  }

  /** Check if session is in a terminal state */
  get isTerminal(): boolean {
    return this.status === 'merged' || this.status === 'failed' || this.status === 'cancelled';
  }

  /** Check if session is actively processing */
  get isActive(): boolean {
    return !this.isTerminal && this.status !== 'escalated';
  }

  // ── State transitions ─────────────────────────────────────────

  transition(to: SessionStatus, eventData?: Record<string, unknown>): void {
    const from = this.data.status;
    this.machine.transition(to);
    this.data.status = this.machine.state;
    this.data.updatedAt = new Date().toISOString();

    if (to === 'merged' || to === 'failed' || to === 'cancelled') {
      this.data.completedAt = new Date().toISOString();
    }

    this.addEvent('session.transition', { from, to, ...eventData });
  }

  tryTransition(to: SessionStatus, eventData?: Record<string, unknown>): boolean {
    if (!this.machine.canTransition(to)) return false;
    this.transition(to, eventData);
    return true;
  }

  // ── Mutators ──────────────────────────────────────────────────

  setPlan(plan: ImplementationPlan): void {
    this.data.plan = plan;
    this.data.updatedAt = new Date().toISOString();
    this.addEvent('session.plan_set', {
      summary: plan.summary,
      complexity: plan.estimated_complexity,
    });
  }

  setBranch(branch: string, worktreePath: string): void {
    this.data.branch = branch;
    this.data.worktreePath = worktreePath;
    this.data.updatedAt = new Date().toISOString();
    this.addEvent('session.branch_set', { branch, worktreePath });
  }

  setThread(threadId: string): void {
    this.data.threadId = threadId;
    this.data.updatedAt = new Date().toISOString();
  }

  setPR(prNumber: number, prUrl: string): void {
    this.data.prNumber = prNumber;
    this.data.prUrl = prUrl;
    this.data.updatedAt = new Date().toISOString();
    this.addEvent('session.pr_created', { prNumber, prUrl });
  }

  incrementCIAttempts(): number {
    this.data.ciAttempts += 1;
    this.data.updatedAt = new Date().toISOString();
    return this.data.ciAttempts;
  }

  incrementReviewAttempts(): number {
    this.data.reviewAttempts += 1;
    this.data.updatedAt = new Date().toISOString();
    return this.data.reviewAttempts;
  }

  // ── Serialization ─────────────────────────────────────────────

  toJSON(): SessionData {
    return { ...this.data };
  }

  // ── Internal ──────────────────────────────────────────────────

  private addEvent(type: string, data: Record<string, unknown>): void {
    this.data.events.push({
      id: nanoid(8),
      timestamp: new Date().toISOString(),
      type,
      data,
    });
  }
}
