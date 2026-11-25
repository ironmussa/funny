// ─── Domain Errors ──────────────────────────────────────

export type DomainError =
  | { type: 'NOT_FOUND'; message: string; friendlyMessage?: string }
  | { type: 'BAD_REQUEST'; message: string; friendlyMessage?: string }
  | { type: 'FORBIDDEN'; message: string; friendlyMessage?: string }
  | { type: 'VALIDATION'; message: string; friendlyMessage?: string }
  | {
      type: 'PROCESS_ERROR';
      message: string;
      exitCode?: number;
      stderr?: string;
      friendlyMessage?: string;
    }
  | { type: 'CONFLICT'; message: string; friendlyMessage?: string }
  | { type: 'INTERNAL'; message: string; friendlyMessage?: string };

export type DomainErrorType = DomainError['type'];

// ─── Factory helpers ────────────────────────────────────

export const notFound = (message: string): DomainError => ({ type: 'NOT_FOUND', message });
export const badRequest = (message: string): DomainError => ({ type: 'BAD_REQUEST', message });
export const forbidden = (message: string): DomainError => ({ type: 'FORBIDDEN', message });
export const validationErr = (message: string): DomainError => ({ type: 'VALIDATION', message });
export const processError = (message: string, exitCode?: number, stderr?: string): DomainError => ({
  type: 'PROCESS_ERROR',
  message,
  exitCode,
  stderr,
});
export const conflict = (message: string): DomainError => ({ type: 'CONFLICT', message });
export const internal = (message: string): DomainError => ({ type: 'INTERNAL', message });

/** The message of a caught value: an Error's message, or the value itself as text. */
export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
