import type { z } from 'zod';

export type HarnessErrorCode =
  | 'runtime_unavailable'
  | 'unsupported_capability'
  | 'unsupported_sandbox_backend'
  | 'unsupported_tool_exposure'
  | 'tool_validation_failed'
  | 'duplicate_tool'
  | 'agent_execution_failed'
  | 'command_failed'
  | 'approval_unavailable'
  | 'workflow_failed'
  | 'invalid_agent_definition'
  | 'invalid_runtime_request';

/** What the harness records about a failure: the tool, its input issues, an agent's exit code. */
export interface HarnessErrorMetadata {
  toolName?: string;
  issues?: readonly z.core.$ZodIssue[];
  exitCode?: number | null;
}

export interface HarnessErrorOptions {
  cause?: unknown;
  metadata?: HarnessErrorMetadata;
}

export class HarnessError extends Error {
  readonly code: HarnessErrorCode;
  readonly metadata?: HarnessErrorMetadata;

  constructor(code: HarnessErrorCode, message: string, options: HarnessErrorOptions = {}) {
    super(message);
    this.name = 'HarnessError';
    this.code = code;
    this.metadata = options.metadata;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export function toHarnessError(
  err: unknown,
  code: HarnessErrorCode = 'agent_execution_failed',
  fallback = 'Harness operation failed',
): HarnessError {
  if (err instanceof HarnessError) return err;
  if (err instanceof Error) {
    return new HarnessError(code, err.message || fallback, { cause: err });
  }
  return new HarnessError(code, String(err || fallback), { cause: err });
}
