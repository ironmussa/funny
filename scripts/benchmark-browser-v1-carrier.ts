import { create } from '@bufbuild/protobuf';

import {
  BROWSER_V1_CARRIER_EVENTS,
  BROWSER_V1_SCHEMA_FINGERPRINT,
  decodeBrowserCarrier,
  encodeBrowserCarrier,
} from '../packages/shared/src/browser-protocol.ts';
import {
  DeliveryClass,
  ScopeKind,
} from '../packages/shared/src/generated/browser-v1/browser/v1/common_pb.ts';
import { ApplicationEventSchema } from '../packages/shared/src/generated/browser-v1/browser/v1/events_pb.ts';
import { CarrierEnvelopeSchema } from '../packages/shared/src/generated/browser-v1/browser/v1/transport_pb.ts';

interface AcceptanceThresholds {
  iterations: number;
  sustainedIterations: number;
  maxEncodeAverageMicros: number;
  maxDecodeAverageMicros: number;
  maxRoundTripAverageMicros: number;
  maxPayloadBytes: number;
  maxSocketIoFrames: number;
  maxFramedBytes: number;
  maxGeneratedSourceBytes: number;
  maxHeapGrowthBytes: number;
  maxRssGrowthBytes: number;
}

const thresholds = (await Bun.file(
  new URL('../protocol/browser/v1/acceptance.json', import.meta.url),
).json()) as AcceptanceThresholds;
const event = create(ApplicationEventSchema, {
  metadata: {
    eventId: 'benchmark-event-1',
    scope: { kind: ScopeKind.USER, id: 'benchmark-user' },
    sequence: 1n,
    revision: 1n,
  },
  delivery: { deliveryClass: DeliveryClass.SNAPSHOT_RECOVERABLE },
  payload: { case: 'user', value: { eventType: 'profile:updated' } },
});
const envelope = create(CarrierEnvelopeSchema, {
  generatedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
  payload: { case: 'event', value: { payload: { case: 'event', value: event } } },
});

for (let index = 0; index < 1_000; index += 1) {
  decodeBrowserCarrier(encodeBrowserCarrier(envelope));
}

let wire = new Uint8Array();
const encodeStarted = performance.now();
for (let index = 0; index < thresholds.iterations; index += 1) {
  wire = encodeBrowserCarrier(envelope);
}
const encodeAverageMicros = ((performance.now() - encodeStarted) * 1_000) / thresholds.iterations;

const decodeStarted = performance.now();
for (let index = 0; index < thresholds.iterations; index += 1) {
  const decoded = decodeBrowserCarrier(wire);
  if (!decoded.ok) throw new Error(decoded.status.message);
}
const decodeAverageMicros = ((performance.now() - decodeStarted) * 1_000) / thresholds.iterations;

const parserMetadata = JSON.stringify([
  BROWSER_V1_CARRIER_EVENTS.event,
  { _placeholder: true, num: 0 },
]);
const framedBytes = new TextEncoder().encode(parserMetadata).byteLength + wire.byteLength;
const socketIoFrames = 2;

Bun.gc(true);
const memoryBefore = process.memoryUsage();
const sustainedStarted = performance.now();
for (let index = 0; index < thresholds.sustainedIterations; index += 1) {
  const encoded = encodeBrowserCarrier(envelope);
  const decoded = decodeBrowserCarrier(encoded);
  if (!decoded.ok) throw new Error(decoded.status.message);
}
const sustainedElapsedMs = performance.now() - sustainedStarted;
Bun.gc(true);
const memoryAfter = process.memoryUsage();

let generatedSourceBytes = 0;
const generatedGlob = new Bun.Glob('packages/shared/src/generated/browser-v1/browser/v1/*_pb.ts');
for (const path of generatedGlob.scanSync({ cwd: new URL('..', import.meta.url).pathname })) {
  generatedSourceBytes += Bun.file(new URL(`../${path}`, import.meta.url)).size;
}

const measurements = {
  encodeAverageMicros,
  decodeAverageMicros,
  roundTripAverageMicros: (sustainedElapsedMs * 1_000) / thresholds.sustainedIterations,
  payloadBytes: wire.byteLength,
  socketIoFrames,
  framedBytes,
  generatedSourceBytes,
  heapGrowthBytes: Math.max(0, memoryAfter.heapUsed - memoryBefore.heapUsed),
  rssGrowthBytes: Math.max(0, memoryAfter.rss - memoryBefore.rss),
};
console.log(JSON.stringify({ thresholds, measurements }, null, 2));

const failures = [
  ['encodeAverageMicros', measurements.encodeAverageMicros, thresholds.maxEncodeAverageMicros],
  ['decodeAverageMicros', measurements.decodeAverageMicros, thresholds.maxDecodeAverageMicros],
  [
    'roundTripAverageMicros',
    measurements.roundTripAverageMicros,
    thresholds.maxRoundTripAverageMicros,
  ],
  ['payloadBytes', measurements.payloadBytes, thresholds.maxPayloadBytes],
  ['socketIoFrames', measurements.socketIoFrames, thresholds.maxSocketIoFrames],
  ['framedBytes', measurements.framedBytes, thresholds.maxFramedBytes],
  ['generatedSourceBytes', measurements.generatedSourceBytes, thresholds.maxGeneratedSourceBytes],
  ['heapGrowthBytes', measurements.heapGrowthBytes, thresholds.maxHeapGrowthBytes],
  ['rssGrowthBytes', measurements.rssGrowthBytes, thresholds.maxRssGrowthBytes],
].filter(([, actual, maximum]) => (actual as number) > (maximum as number));

if (failures.length > 0) {
  for (const [name, actual, maximum] of failures) {
    console.error(`${name} exceeded threshold: ${actual} > ${maximum}`);
  }
  process.exit(1);
}
