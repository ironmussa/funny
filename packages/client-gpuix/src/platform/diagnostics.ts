import type { ClientDiagnostic, DiagnosticService } from '@funny/client-core';

export interface SafeClientDiagnostic extends Omit<ClientDiagnostic, 'error'> {
  error: { name: string; message: string };
}

const SECRET_VALUE = /(cookie|session|token|password|authorization)(\s*[:=]\s*)([^\s,;]+)/gi;

function safeError(cause: unknown): SafeClientDiagnostic['error'] {
  const name = cause instanceof Error ? cause.name : 'Error';
  const rawMessage = cause instanceof Error ? cause.message : String(cause);
  return { name, message: rawMessage.replaceAll(SECRET_VALUE, '$1$2[redacted]') };
}

export class NativeDiagnosticService implements DiagnosticService {
  constructor(private readonly sink: (diagnostic: SafeClientDiagnostic) => void) {}

  report(diagnostic: ClientDiagnostic): void {
    this.sink({ ...diagnostic, error: safeError(diagnostic.error) });
  }
}
