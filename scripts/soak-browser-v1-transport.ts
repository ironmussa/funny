import { create, type MessageInitShape } from '@bufbuild/protobuf';

import {
  BROWSER_V1_SCHEMA_FINGERPRINT,
  decodeBrowserCarrier,
  encodeBrowserCarrier,
} from '../packages/shared/src/browser-protocol.ts';
import {
  DeliveryClass,
  ScopeKind,
} from '../packages/shared/src/generated/browser-v1/browser/v1/common_pb.ts';
import { ApplicationEventSchema } from '../packages/shared/src/generated/browser-v1/browser/v1/events_pb.ts';
import { InteractiveEnvelopeSchema } from '../packages/shared/src/generated/browser-v1/browser/v1/interactive_pb.ts';
import { OperationRequestSchema } from '../packages/shared/src/generated/browser-v1/browser/v1/operations_pb.ts';
import { CarrierEnvelopeSchema } from '../packages/shared/src/generated/browser-v1/browser/v1/transport_pb.ts';

const thresholds = await Bun.file(
  new URL('../protocol/browser/v1/acceptance.json', import.meta.url),
).json();
const carrier = (payload: MessageInitShape<typeof CarrierEnvelopeSchema>['payload']) =>
  create(CarrierEnvelopeSchema, {
    generatedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
    payload,
  });
const envelopes = [
  carrier({
    case: 'operation',
    value: {
      payload: {
        case: 'request',
        value: create(OperationRequestSchema, {
          metadata: { requestId: 'soak-operation' },
          operation: { case: 'ptyList', value: {} },
        }),
      },
    },
  }),
  carrier({
    case: 'event',
    value: {
      payload: {
        case: 'event',
        value: create(ApplicationEventSchema, {
          metadata: {
            eventId: 'soak-event',
            scope: { kind: ScopeKind.USER, id: 'soak-user' },
            sequence: 1n,
            revision: 1n,
          },
          delivery: { deliveryClass: DeliveryClass.SNAPSHOT_RECOVERABLE },
          payload: { case: 'user', value: { eventType: 'thread:share-granted' } },
        }),
      },
    },
  }),
  carrier({
    case: 'interactive',
    value: create(InteractiveEnvelopeSchema, {
      delivery: { deliveryClass: DeliveryClass.DURABLE },
      payload: {
        case: 'terminal',
        value: {
          terminalId: 'soak-terminal',
          payload: { case: 'output', value: { sequence: 1n, data: new Uint8Array(1024) } },
        },
      },
    }),
  }),
  carrier({
    case: 'interactive',
    value: create(InteractiveEnvelopeSchema, {
      delivery: { deliveryClass: DeliveryClass.COALESCIBLE },
      payload: {
        case: 'browserSession',
        value: {
          browserSessionId: 'soak-browser',
          payload: {
            case: 'frame',
            value: {
              sequence: 1n,
              frame: {
                authorizedUrl: '/api/browser-v1/resources/soak-frame',
                mediaType: 'image/jpeg',
                byteLength: 262144n,
              },
            },
          },
        },
      },
    }),
  }),
];

Bun.gc(true);
const before = process.memoryUsage();
const started = performance.now();
await Promise.all(
  envelopes.map(async (envelope) => {
    for (let index = 0; index < thresholds.soakIterationsPerClass; index += 1) {
      const decoded = decodeBrowserCarrier(encodeBrowserCarrier(envelope));
      if (!decoded.ok) throw new Error(decoded.status.message);
      if (index % 1_000 === 0) await Bun.sleep(0);
    }
  }),
);
const elapsedMs = performance.now() - started;
Bun.gc(true);
const after = process.memoryUsage();
const totalIterations = thresholds.soakIterationsPerClass * envelopes.length;
const measurements = {
  totalIterations,
  elapsedMs,
  averageMicros: (elapsedMs * 1_000) / totalIterations,
  heapGrowthBytes: Math.max(0, after.heapUsed - before.heapUsed),
  rssGrowthBytes: Math.max(0, after.rss - before.rss),
};
console.log(JSON.stringify({ thresholds, measurements }, null, 2));
if (
  measurements.averageMicros > thresholds.maxSoakAverageMicros ||
  measurements.heapGrowthBytes > thresholds.maxSoakHeapGrowthBytes ||
  measurements.rssGrowthBytes > thresholds.maxSoakRssGrowthBytes
) {
  throw new Error('browser.v1 production-like soak exceeded an acceptance threshold');
}
