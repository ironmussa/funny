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
