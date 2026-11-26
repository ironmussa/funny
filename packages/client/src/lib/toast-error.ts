/**
 * Centralized error toast helper.
 *
 * Maps DomainError to user-friendly, translatable messages while preserving
 * the raw error for console/telemetry logging.
 *
 * Usage:
 *   const result = await api.doSomething();
 *   if (result.isErr()) return toastError(result.error);
 *
 *   // With endpoint-specific context:
 *   if (result.isErr()) return toastError(result.error, 'transcribeToken');
 */

import type { DomainError } from '@funny/shared/errors';

import { toast, type ToastOptions } from '@/components/ui/toast';
import i18n from '@/i18n/config';
import { createClientLogger } from '@/lib/client-logger';

const log = createClientLogger('toast-error');

/**
 * Show a user-friendly error toast for a DomainError.
 *
 * Resolution order:
 *   1. `error.friendlyMessage` (server-provided)
 *   2. `errors.{context}.{type}` (endpoint-specific i18n key)
 *   3. `errors.generic.{type}` (per-type fallback)
 *   4. Hardcoded fallback
 */
export function toastError(error: DomainError, context?: string, opts?: ToastOptions): void {
  // Always log the raw error for debugging
  log.warn('API error', {
    type: error.type,
    message: error.message,
    context: context ?? 'unknown',
  });

  const friendlyMessage = resolveFriendlyMessage(error, context);
  toast.error(friendlyMessage, opts);
}

function resolveFriendlyMessage(error: DomainError, context?: string): string {
  const t = i18n.t.bind(i18n);

  // 1. Server-provided friendly message
  if (error.friendlyMessage) {
    return error.friendlyMessage;
  }

  // 2. Context-specific i18n key  (e.g. errors.transcribeToken.INTERNAL)
  //    Pass the raw error.message as {{message}} so templates can include it.
  if (context) {
    const contextKey = `errors.${context}.${error.type}`;
    const contextMsg = t(contextKey, { defaultValue: '', message: error.message });
    if (contextMsg) return contextMsg;
  }

  // 3. Generic per-type i18n key  (e.g. errors.generic.INTERNAL)
  const genericKey = `errors.generic.${error.type}`;
  const genericMsg = t(genericKey, { defaultValue: '', message: error.message });
  if (genericMsg) return genericMsg;

  // 4. Hardcoded fallback
  return t('errors.generic.unknown', { defaultValue: 'Something went wrong. Please try again.' });
}
