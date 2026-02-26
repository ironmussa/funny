// ─── Domain Errors ──────────────────────────────────────

export type DomainError =
  | { type: 'NOT_FOUND'; message: string }
  | { type: 'BAD_REQUEST'; message: string }
  | { type: 'FORBIDDEN'; message: string }
  | { type: 'VALIDATION'; message: string }
  | { type: 'PROCESS_ERROR'; message: string; exitCode?: number; stderr?: string }
  | { type: 'CONFLICT'; message: string }
  | { type: 'INTERNAL'; message: string };

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
