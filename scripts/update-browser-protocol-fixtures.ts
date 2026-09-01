import { fromJson, toBinary } from '@bufbuild/protobuf';
import type { GenMessage, Message } from '@bufbuild/protobuf/codegenv2';

import { StatusSchema } from '../packages/shared/src/generated/browser-v1/browser/v1/common_pb.ts';
import { ControlEnvelopeSchema } from '../packages/shared/src/generated/browser-v1/browser/v1/control_pb.ts';
import { ApplicationEventSchema } from '../packages/shared/src/generated/browser-v1/browser/v1/events_pb.ts';
import { InteractiveEnvelopeSchema } from '../packages/shared/src/generated/browser-v1/browser/v1/interactive_pb.ts';
import { NegotiationRequestSchema } from '../packages/shared/src/generated/browser-v1/browser/v1/negotiation_pb.ts';
import { OperationRequestSchema } from '../packages/shared/src/generated/browser-v1/browser/v1/operations_pb.ts';
import { CarrierEnvelopeSchema } from '../packages/shared/src/generated/browser-v1/browser/v1/transport_pb.ts';

const fixturePath = new URL('../protocol/browser/v1/fixtures/golden.json', import.meta.url);
const schemas: Record<string, GenMessage<Message>> = {
  'browser.v1.Status': StatusSchema,
  'browser.v1.NegotiationRequest': NegotiationRequestSchema,
  'browser.v1.OperationRequest': OperationRequestSchema,
  'browser.v1.ApplicationEvent': ApplicationEventSchema,
  'browser.v1.InteractiveEnvelope': InteractiveEnvelopeSchema,
  'browser.v1.ControlEnvelope': ControlEnvelopeSchema,
  'browser.v1.CarrierEnvelope': CarrierEnvelopeSchema,
};

interface GoldenFixture {
  name: string;
  messageType: string;
  protoJson: unknown;
  wireHex: string;
}

const fixtures = (await Bun.file(fixturePath).json()) as GoldenFixture[];
for (const fixture of fixtures) {
  const schema = schemas[fixture.messageType];
  if (!schema) throw new Error(`No schema registered for ${fixture.messageType}`);
  fixture.wireHex = Buffer.from(toBinary(schema, fromJson(schema, fixture.protoJson))).toString(
    'hex',
  );
}

await Bun.write(fixturePath, `${JSON.stringify(fixtures, null, 2)}\n`);
