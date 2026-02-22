/**
 * ShutdownManager — centralized cleanup registry.
 *
 * Services self-register their cleanup functions at import time.
 * On shutdown, the manager executes them in phase order:
 *
 *   Phase 0 (SERVER):   Release the port immediately
 *   Phase 1 (SERVICES): Stop schedulers, kill processes, flush telemetry (parallel)
 *   Phase 2 (DATABASE): Close DB last — other cleanup may still write
 *   Phase 3 (FINAL):    Platform cleanup (Windows tree kill) + process.exit
 */

import { log } from '../lib/abbacchio.js';

export const ShutdownPhase = {
  SERVER: 0,
  SERVICES: 1,
  DATABASE: 2,
  FINAL: 3,
} as const;

export type ShutdownPhase = (typeof ShutdownPhase)[keyof typeof ShutdownPhase];
export type ShutdownMode = 'hard' | 'hotReload';

interface Registration {
  name: string;
  fn: (mode: ShutdownMode) => void | Promise<void>;
  phase: ShutdownPhase;
  /** If false, skipped during --watch restarts (default: true) */
  runOnHotReload: boolean;
}

class ShutdownManager {
  private registrations: Registration[] = [];
  private running = false;

  /**
   * Register a cleanup function.
   *
   * @param name            Human-readable name for logging
   * @param fn              Cleanup function (receives the shutdown mode)
   * @param phase           When to run (default: SERVICES)
   * @param runOnHotReload  Whether to run during --watch restarts (default: true)
   */
  register(
    name: string,
    fn: (mode: ShutdownMode) => void | Promise<void>,
    phase: ShutdownPhase = ShutdownPhase.SERVICES,
    runOnHotReload = true,
  ): void {
    this.registrations.push({ name, fn, phase, runOnHotReload });
  }

  /**
   * Execute all registered cleanup in phase order.
   * Within each phase, functions run in parallel.
   */
  async run(mode: ShutdownMode): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Group by phase, filtering by mode
    const byPhase = new Map<ShutdownPhase, Registration[]>();
    for (const reg of this.registrations) {
      if (mode === 'hotReload' && !reg.runOnHotReload) continue;
      const list = byPhase.get(reg.phase) ?? [];
      list.push(reg);
      byPhase.set(reg.phase, list);
    }

    // Execute phases in ascending order
    const phases = [...byPhase.keys()].sort((a, b) => a - b);
    for (const phase of phases) {
      const regs = byPhase.get(phase)!;
      await Promise.allSettled(
        regs.map(async (reg) => {
          try {
            await reg.fn(mode);
            log.info(`[shutdown] ${reg.name} done`, { namespace: 'shutdown' });
          } catch (err) {
            log.error(`[shutdown] ${reg.name} failed`, { namespace: 'shutdown', error: err });
          }
        }),
      );
    }

    this.running = false;
  }
}

export const shutdownManager = new ShutdownManager();
