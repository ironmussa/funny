/**
 * Typed error hierarchy for the pipeline service.
 *
 * Provides domain-specific error classes and a Result<T> type
 * to replace scattered `catch (err: any)` patterns with structured handling.
 */

// ── Result type ─────────────────────────────────────────────────

export type Result<T, E = PipelineError> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

// ── Error hierarchy ─────────────────────────────────────────────

/**
 * Base error for all pipeline service errors.
 * Carries a machine-readable `code` for programmatic handling.
 */
export class PipelineError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PipelineError';
  }
}

/** Thrown when an agent execution fails (timeout, crash, bad output). */
export class AgentExecutionError extends PipelineError {
  constructor(
    public readonly agentName: string,
    message: string,
    cause?: unknown,
  ) {
    super(message, 'AGENT_EXECUTION_FAILED', cause);
    this.name = 'AgentExecutionError';
  }
}

/** Thrown when a git operation fails (merge, rebase, checkout). */
export class GitOperationError extends PipelineError {
  constructor(
    public readonly operation: string,
    message: string,
    cause?: unknown,
  ) {
    super(message, 'GIT_OPERATION_FAILED', cause);
    this.name = 'GitOperationError';
  }
}

/** Thrown when manifest read/write fails. */
export class ManifestError extends PipelineError {
  constructor(message: string, cause?: unknown) {
    super(message, 'MANIFEST_ERROR', cause);
    this.name = 'ManifestError';
  }
}

/** Thrown when pipeline timeout is reached. */
export class TimeoutError extends PipelineError {
  constructor(
    public readonly timeoutMs: number,
    message?: string,
  ) {
    super(message ?? `Pipeline timeout after ${timeoutMs}ms`, 'PIPELINE_TIMEOUT');
    this.name = 'TimeoutError';
  }
}

/** Thrown when an integration saga step fails. */
export class SagaStepError extends PipelineError {
  constructor(
    public readonly stepName: string,
    message: string,
    cause?: unknown,
  ) {
    super(message, 'SAGA_STEP_FAILED', cause);
    this.name = 'SagaStepError';
  }
}

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Extract a message string from an unknown caught value.
 * Replaces the `(err as any).message` pattern.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}
