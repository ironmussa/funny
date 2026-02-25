/**
 * SessionStore — in-memory + file-based persistence for sessions.
 *
 * Stores sessions as individual JSON files in the persist directory.
 * Provides CRUD operations and queries by status, issue, etc.
 * Emits events on state transitions via the EventBus.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Session, type SessionData, type SessionStatus } from './session.js';
import type { EventBus } from '../infrastructure/event-bus.js';
import { logger } from '../infrastructure/logger.js';

// ── SessionStore ────────────────────────────────────────────────

export class SessionStore {
  private sessions = new Map<string, Session>();
  private persistDir: string;

  constructor(
    private eventBus: EventBus,
    persistPath?: string,
  ) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '~';
    this.persistDir = persistPath ?? join(home, '.funny', 'sessions');

    if (!existsSync(this.persistDir)) {
      mkdirSync(this.persistDir, { recursive: true });
    }

    this.loadFromDisk();
  }

  // ── CRUD ──────────────────────────────────────────────────────

  add(session: Session): void {
    this.sessions.set(session.id, session);
    this.persist(session);
    logger.info({ sessionId: session.id, issue: session.issue.number }, 'Session added');
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  remove(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;

    this.sessions.delete(id);
    this.removeFile(id);
    logger.info({ sessionId: id }, 'Session removed');
    return true;
  }

  // ── Queries ───────────────────────────────────────────────────

  list(): Session[] {
    return Array.from(this.sessions.values());
  }

  byStatus(status: SessionStatus): Session[] {
    return this.list().filter((s) => s.status === status);
  }

  byIssue(issueNumber: number): Session | undefined {
    if (issueNumber === 0) return undefined; // prompt-only sessions have no real issue
    return this.list().find((s) => s.issue.number === issueNumber);
  }

  active(): Session[] {
    return this.list().filter((s) => s.isActive);
  }

  terminal(): Session[] {
    return this.list().filter((s) => s.isTerminal);
  }

  activeCount(): number {
    return this.active().length;
  }

  // ── State transitions (with event publishing) ─────────────────

  async transition(
    sessionId: string,
    to: SessionStatus,
    eventData?: Record<string, unknown>,
  ): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const from = session.status;
    const ok = session.tryTransition(to, eventData);
    if (!ok) return false;

    this.persist(session);

    await this.eventBus.publish({
      event_type: 'session.transition' as any,
      request_id: sessionId,
      timestamp: new Date().toISOString(),
      data: { sessionId, from, to, issueNumber: session.issue.number, ...eventData },
    });

    logger.info({ sessionId, from, to }, 'Session transitioned');
    return true;
  }

  // ── Update helpers ────────────────────────────────────────────

  update(sessionId: string, fn: (session: Session) => void): Session | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    fn(session);
    this.persist(session);
    return session;
  }

  // ── Persistence ───────────────────────────────────────────────

  private persist(session: Session): void {
    try {
      const filePath = join(this.persistDir, `${session.id}.json`);
      writeFileSync(filePath, JSON.stringify(session.toJSON(), null, 2), 'utf-8');
    } catch (err: any) {
      logger.error({ sessionId: session.id, err: err.message }, 'Failed to persist session');
    }
  }

  private removeFile(id: string): void {
    try {
      const filePath = join(this.persistDir, `${id}.json`);
      if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
    } catch (err: any) {
      logger.error({ sessionId: id, err: err.message }, 'Failed to remove session file');
    }
  }

  private loadFromDisk(): void {
    try {
      const files = readdirSync(this.persistDir).filter((f) => f.endsWith('.json'));
      let staleCount = 0;
      for (const file of files) {
        try {
          const raw = readFileSync(join(this.persistDir, file), 'utf-8');
          const data = JSON.parse(raw) as SessionData;
          const session = Session.fromData(data);

          // Sessions that were active when the process died can never complete —
          // mark them as failed so they don't block the parallel limit.
          if (session.isActive) {
            session.tryTransition('failed', { error: 'Stale session: agent restarted' });
            this.persist(session);
            staleCount++;
          }

          this.sessions.set(session.id, session);
        } catch (err: any) {
          logger.warn({ file, err: err.message }, 'Skipping corrupt session file');
        }
      }
      logger.info({ count: this.sessions.size, staleRecovered: staleCount }, 'Sessions loaded from disk');
    } catch {
      // Directory doesn't exist or is empty — fine
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────

  /** Remove all terminal sessions older than the given age in milliseconds */
  purgeOlderThan(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    let purged = 0;

    for (const session of this.terminal()) {
      const completedAt = session.toJSON().completedAt;
      if (completedAt && new Date(completedAt).getTime() < cutoff) {
        this.remove(session.id);
        purged++;
      }
    }

    return purged;
  }
}
