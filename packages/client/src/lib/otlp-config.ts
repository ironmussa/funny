const FALSE_FLAGS = new Set(['0', 'false', 'no', 'off']);

function normalizeFlag(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

/**
 * Client telemetry follows the same rule as the runtime
 * (`packages/runtime/src/lib/telemetry-config.ts`): configuring an endpoint is
 * what enables export, in development as well as production. Previously the
 * browser stayed silent in development, so client metrics and logs — including
 * the always-on instrumentation listed in `packages/client/CLAUDE.md` — could
 * only ever be observed in production.
 *
 * `VITE_OTLP_ENABLED=false` remains the escape hatch to silence a noisy tab.
 */
export function isOtlpEnabled(
  endpoint: string | undefined,
  enabledFlag: string | undefined,
): boolean {
  if (!endpoint?.trim()) return false;

  const flag = normalizeFlag(enabledFlag);
  if (flag && FALSE_FLAGS.has(flag)) return false;

  return true;
}

export const otlpEndpoint =
  (import.meta.env.VITE_OTLP_ENDPOINT as string | undefined)?.trim() || undefined;

export const otlpEnabled = isOtlpEnabled(
  otlpEndpoint,
  import.meta.env.VITE_OTLP_ENABLED as string | undefined,
);
