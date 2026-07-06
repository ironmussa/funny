const TRUE_FLAGS = new Set(['1', 'true', 'yes', 'on']);
const FALSE_FLAGS = new Set(['0', 'false', 'no', 'off']);

function normalizeFlag(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

export function isOtlpEnabled(
  endpoint: string | undefined,
  enabledFlag: string | undefined,
  isProd: boolean,
): boolean {
  if (!endpoint?.trim()) return false;

  const flag = normalizeFlag(enabledFlag);
  if (flag && TRUE_FLAGS.has(flag)) return true;
  if (flag && FALSE_FLAGS.has(flag)) return false;

  return isProd;
}

export const otlpEndpoint =
  (import.meta.env.VITE_OTLP_ENDPOINT as string | undefined)?.trim() || undefined;

export const otlpEnabled = isOtlpEnabled(
  otlpEndpoint,
  import.meta.env.VITE_OTLP_ENABLED as string | undefined,
  import.meta.env.PROD,
);
