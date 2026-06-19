/**
 * @domain subdomain: Agent Execution
 * @domain subdomain-type: core
 * @domain type: domain-service
 * @domain layer: application
 * @domain depends: AgentOrchestrator
 *
 * Periodically reaps idle, turn-terminal agent processes so their process
 * trees (and the MCP servers they spawned) stop consuming memory. Selection
 * and termination live in the orchestrator (`getIdleCandidates` /
 * `reapIdleAgent`); this service owns only the clock and the provider policy.
 */

import type { AgentOrchestrator, IdleReapPolicy } from '@funny/core/agents';

import { log } from '../lib/logger.js';

export interface IdleReaperConfig {
  policy: IdleReapPolicy;
  sweepMs: number;
}

/** Parse a non-negative integer env var, falling back to `def`. */
function nonNegInt(raw: string | undefined, def: number): number {
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

/**
 * Read reaper config from the environment.
 * - `FUNNY_AGENT_IDLE_REAP_MS` (default 600000) — non-claude idle window.
 * - `FUNNY_AGENT_IDLE_REAP_MS_CLAUDE` (default 0 = disabled) — claude window.
 * - `FUNNY_AGENT_IDLE_SWEEP_MS` (default 60000) — sweep interval.
 * A window of `0` disables reaping for that class.
 */
export function loadIdleReaperConfig(env: NodeJS.ProcessEnv = process.env): IdleReaperConfig {
  return {
    policy: {
      defaultIdleMs: nonNegInt(env.FUNNY_AGENT_IDLE_REAP_MS, 600_000),
      claudeIdleMs: nonNegInt(env.FUNNY_AGENT_IDLE_REAP_MS_CLAUDE, 0),
    },
    sweepMs: nonNegInt(env.FUNNY_AGENT_IDLE_SWEEP_MS, 60_000),
  };
}

/** Just the orchestrator surface the reaper needs (keeps tests trivial to fake). */
type ReapableOrchestrator = Pick<AgentOrchestrator, 'getIdleCandidates' | 'reapIdleAgent'>;

export class IdleReaper {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private orchestrator: ReapableOrchestrator,
    private config: IdleReaperConfig = loadIdleReaperConfig(),
  ) {}

  start(): void {
    if (this.config.policy.defaultIdleMs <= 0 && this.config.policy.claudeIdleMs <= 0) {
      log.info('Idle reaper disabled (both windows 0)', { namespace: 'agent' });
      return;
    }
    // Dedupe across bun --watch reloads: a fresh module instance clears the
    // previous one's ticker so we never run two sweeps in parallel.
    const g = globalThis as { __funnyIdleReaperTimer?: ReturnType<typeof setInterval> };
    if (g.__funnyIdleReaperTimer) clearInterval(g.__funnyIdleReaperTimer);

    this.timer = setInterval(() => void this.sweep(), this.config.sweepMs);
    this.timer.unref?.();
    g.__funnyIdleReaperTimer = this.timer;

    log.info('Idle reaper started', {
      namespace: 'agent',
      defaultIdleMs: this.config.policy.defaultIdleMs,
      claudeIdleMs: this.config.policy.claudeIdleMs,
      sweepMs: this.config.sweepMs,
    });
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    const g = globalThis as { __funnyIdleReaperTimer?: ReturnType<typeof setInterval> };
    if (g.__funnyIdleReaperTimer === this.timer) g.__funnyIdleReaperTimer = undefined;
    this.timer = null;
  }

  /** Run a single sweep. Exposed for tests. */
  async sweep(): Promise<void> {
    const candidates = this.orchestrator.getIdleCandidates(Date.now(), this.config.policy);
    for (const threadId of candidates) {
      // Re-check idleness immediately before killing: a follow-up may have
      // arrived (refreshing activity / clearing the terminal result) between
      // candidate selection and now, in which case we must not reap.
      const stillIdle = this.orchestrator.getIdleCandidates(Date.now(), this.config.policy);
      if (!stillIdle.includes(threadId)) continue;
      try {
        await this.orchestrator.reapIdleAgent(threadId);
      } catch (err) {
        log.error('Idle reap failed', {
          namespace: 'agent',
          threadId,
          error: (err as Error).message,
        });
      }
    }
  }
}
