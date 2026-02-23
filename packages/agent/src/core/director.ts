/**
 * Director — pure TypeScript orchestration logic (no LLM).
 *
 * Reads the manifest, resolves dependencies, orders by priority,
 * and dispatches the Integrator for each eligible branch.
 *
 * Activated by:
 *   - Event-driven: pipeline.completed → auto-trigger
 *   - Manual: POST /director/run
 *   - Scheduled: configurable interval timer
 */

import { execute } from '@funny/core/git';
import type { ManifestManager } from './manifest-manager.js';
import type { Integrator } from './integrator.js';
import type { ManifestReadyEntry } from './manifest-types.js';
import type { DirectorStatus } from './manifest-types.js';
import type { PipelineEvent, PipelineEventType } from './types.js';
import type { EventBus } from '../infrastructure/event-bus.js';
import type { RequestLogger } from '../infrastructure/request-logger.js';
import { logger } from '../infrastructure/logger.js';

export class Director {
  private running = false;
  private lastCycleAt: string | null = null;
  private scheduleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private manifestManager: ManifestManager,
    private integrator: Integrator,
    private eventBus: EventBus,
    private projectPath: string,
    private requestLogger?: RequestLogger,
  ) {}

  // ── Public API ──────────────────────────────────────────────────

  isRunning(): boolean {
    return this.running;
  }

  async getStatus(): Promise<DirectorStatus> {
    const manifest = await this.manifestManager.read();

    // Build merge queue with eligibility info
    const mergedBranches = new Set(manifest.merge_history.map((e) => e.branch));
    const mergeQueue = manifest.ready.map((entry) => {
      const blockedBy = entry.depends_on.filter((dep) => !mergedBranches.has(dep));
      return {
        branch: entry.branch,
        priority: entry.priority,
        eligible: blockedBy.length === 0,
        blocked_by: blockedBy.length > 0 ? blockedBy : undefined,
      };
    });

    return {
      running: this.running,
      last_cycle_at: this.lastCycleAt,
      manifest_summary: {
        ready: manifest.ready.length,
        pending_merge: manifest.pending_merge.length,
        merge_history: manifest.merge_history.length,
      },
      merge_queue,
    };
  }

  /**
   * Start the scheduled Director trigger.
   * Runs a cycle every `intervalMs` milliseconds.
   * Pass 0 to disable (default).
   */
  startSchedule(intervalMs: number): void {
    if (intervalMs <= 0) return;

    this.scheduleTimer = setInterval(() => {
      if (this.running) return;
      this.runCycle('scheduled').catch((err) => {
        logger.error({ err: err.message }, 'Scheduled director cycle failed');
      });
    }, intervalMs);

    logger.info({ intervalMs }, 'Director schedule started');
  }

  /**
   * Stop the scheduled Director trigger.
   */
  stopSchedule(): void {
    if (this.scheduleTimer) {
      clearInterval(this.scheduleTimer);
      this.scheduleTimer = null;
      logger.info('Director schedule stopped');
    }
  }

  /**
   * Run a full director cycle: process ready branches and detect stale PRs.
   */
  async runCycle(trigger: 'event' | 'manual' | 'scheduled'): Promise<void> {
    if (this.running) {
      logger.warn('Director cycle already running, skipping');
      return;
    }

    this.running = true;
    const cycleStart = Date.now();

    try {
      const manifest = await this.manifestManager.read();

      // Update main HEAD
      let mainHead = '';
      try {
        const { stdout } = await execute('git', ['rev-parse', 'HEAD'], {
          cwd: this.projectPath,
        });
        mainHead = stdout.trim();
        await this.manifestManager.updateMainHead(mainHead);
      } catch {
        logger.warn('Could not determine main HEAD, continuing without update');
      }

      this.emitEvent('director.activated', '', {
        trigger,
        ready_count: manifest.ready.length,
        pending_merge_count: manifest.pending_merge.length,
      });

      logger.info(
        { trigger, ready: manifest.ready.length, pendingMerge: manifest.pending_merge.length },
        'Director cycle started',
      );
      this.requestLogger?.info('director', 'system', 'cycle_started', `Director cycle triggered by ${trigger}`, { trigger, ready_count: manifest.ready.length, pending_merge_count: manifest.pending_merge.length });

      // ── Process ready[] entries ─────────────────────────────────

      const mergedBranches = new Set(manifest.merge_history.map((e) => e.branch));

      // Filter for eligible entries (all dependencies merged)
      const eligible: ManifestReadyEntry[] = [];
      for (const entry of manifest.ready) {
        const blockedBy = entry.depends_on.filter((dep) => !mergedBranches.has(dep));
        if (blockedBy.length > 0) {
          logger.info(
            { branch: entry.branch, blockedBy },
            'Branch blocked by unmerged dependencies',
          );
          continue;
        }
        eligible.push(entry);
      }

      // Sort by priority (lower number = higher priority)
      eligible.sort((a, b) => a.priority - b.priority);

      let integrated = 0;
      let failed = 0;

      // Process sequentially
      for (const entry of eligible) {
        if (entry.skip_merge) {
          logger.info({ branch: entry.branch }, 'Skipping integration (skip_merge)');
          continue;
        }

        logger.info({ branch: entry.branch, priority: entry.priority }, 'Dispatching integration');
        this.emitEvent('director.integration.dispatched', entry.request_id, {
          branch: entry.branch,
          priority: entry.priority,
        });

        const result = await this.integrator.integrate(entry, this.projectPath);

        if (result.success && result.pr_number && result.pr_url) {
          await this.manifestManager.moveToPendingMerge(entry.branch, {
            pr_number: result.pr_number,
            pr_url: result.pr_url,
            integration_branch: result.integration_branch!,
            base_main_sha: result.base_main_sha!,
          });

          this.emitEvent('director.integration.pr_created', entry.request_id, {
            branch: entry.branch,
            pr_number: result.pr_number,
            pr_url: result.pr_url,
          });
          integrated++;
        } else {
          logger.error(
            { branch: entry.branch, error: result.error },
            'Integration failed, keeping in ready[] for retry',
          );
          failed++;
        }
      }

      // ── Detect stale PRs in pending_merge[] ───────────────────

      if (mainHead) {
        // Re-read manifest (may have changed during integration)
        const updatedManifest = await this.manifestManager.read();
        for (const entry of updatedManifest.pending_merge) {
          if (entry.base_main_sha && entry.base_main_sha !== mainHead) {
            logger.warn(
              { branch: entry.branch, prNumber: entry.pr_number, oldBase: entry.base_main_sha, newBase: mainHead },
              'Stale PR detected — main has advanced',
            );
            this.emitEvent('director.pr.rebase_needed', entry.request_id, {
              branch: entry.branch,
              pr_number: entry.pr_number,
              old_base: entry.base_main_sha,
              new_base: mainHead,
            });
          }
        }
      }

      // ── Cycle complete ────────────────────────────────────────

      const duration = Date.now() - cycleStart;
      this.lastCycleAt = new Date().toISOString();

      this.emitEvent('director.cycle.completed', '', {
        trigger,
        duration_ms: duration,
        eligible_count: eligible.length,
        integrated,
        failed,
      });

      logger.info(
        { trigger, duration, eligible: eligible.length, integrated, failed },
        'Director cycle completed',
      );
      this.requestLogger?.info('director', 'system', 'cycle_completed', `Director cycle completed: ${integrated} integrated, ${failed} failed`, { trigger, duration_ms: duration, eligible_count: eligible.length, integrated, failed });
    } catch (err: any) {
      logger.error({ err: err.message }, 'Director cycle failed');
      this.requestLogger?.error('director', 'system', 'cycle_failed', err.message, { error: err.message });
      throw err;
    } finally {
      this.running = false;
    }
  }

  // ── Internal ──────────────────────────────────────────────────

  private emitEvent(
    eventType: PipelineEventType,
    requestId: string,
    data: Record<string, unknown> = {},
  ): void {
    const event: PipelineEvent = {
      event_type: eventType,
      request_id: requestId,
      timestamp: new Date().toISOString(),
      data,
    };
    this.eventBus.publish(event);
  }
}
