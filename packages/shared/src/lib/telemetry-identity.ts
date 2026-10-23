type TelemetrySource = 'funny-client' | 'funny-server' | 'funny-runtime';

function createIdentity(source: TelemetrySource) {
  const instanceId = crypto.randomUUID();
  return {
    source,
    instanceId,
    // Explicit headers also support transports predating the identity options.
    headers: { 'X-Source': source, 'X-Instance-Id': instanceId },
    resourceAttributes: { 'service.instance.id': instanceId },
  };
}

const identities = new Map<TelemetrySource, ReturnType<typeof createIdentity>>();

/** One identity per emitter in this process/page, shared by all telemetry clients. */
export function getTelemetryIdentity(source: TelemetrySource) {
  let identity = identities.get(source);
  if (!identity) {
    identity = createIdentity(source);
    identities.set(source, identity);
  }
  return identity;
}

/**
 * Test runs (bun test / vitest set NODE_ENV=test) inherit the developer's .env,
 * so without this guard their fixture errors land in the live Abbacchio channels
 * and ~/.funny/logs, indistinguishable from the running app's.
 */
export function isTestProcess(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV === 'test';
}

/** OTLP export is opt-in via OTLP_ENDPOINT and never active inside a test run. */
export function isTelemetryExportEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return !!env.OTLP_ENDPOINT && !isTestProcess(env);
}
