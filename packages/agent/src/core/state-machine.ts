/**
 * Generic finite state machine with typed transitions.
 */

import { logger } from '../infrastructure/logger.js';

// ── StateMachine class ──────────────────────────────────────────

export class TransitionError extends Error {
  constructor(
    public readonly from: string,
    public readonly to: string,
    public readonly label: string,
  ) {
    super(`Invalid transition [${label}]: ${from} → ${to}`);
    this.name = 'TransitionError';
  }
}

export class StateMachine<TState extends string> {
  private current: TState;

  constructor(
    private validTransitions: Record<TState, TState[]>,
    initialState: TState,
    private label: string,
  ) {
    this.current = initialState;
  }

  get state(): TState {
    return this.current;
  }

  /**
   * Check if a transition to the target state is valid.
   */
  canTransition(to: TState): boolean {
    const allowed = this.validTransitions[this.current];
    return allowed?.includes(to) ?? false;
  }

  /**
   * Transition to a new state. Throws TransitionError if invalid.
   */
  transition(to: TState): void {
    if (!this.canTransition(to)) {
      throw new TransitionError(this.current, to, this.label);
    }
    this.current = to;
  }

  /**
   * Attempt a transition. Returns false (and logs a warning) if invalid.
   */
  tryTransition(to: TState): boolean {
    if (!this.canTransition(to)) {
      logger.warn(
        { label: this.label, from: this.current, to },
        'Invalid state transition rejected',
      );
      return false;
    }
    this.current = to;
    return true;
  }
}
