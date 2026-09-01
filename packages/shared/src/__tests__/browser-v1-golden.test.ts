import { describe, expect, test } from 'bun:test';

import { fromBinary, fromJson, toBinary, toJson } from '@bufbuild/protobuf';
import type { JsonValue, Message } from '@bufbuild/protobuf';
import type { GenMessage } from '@bufbuild/protobuf/codegenv2';

import { StatusSchema } from '../generated/browser-v1/browser/v1/common_pb';
import { ControlEnvelopeSchema } from '../generated/browser-v1/browser/v1/control_pb';
import { ApplicationEventSchema } from '../generated/browser-v1/browser/v1/events_pb';
import { InteractiveEnvelopeSchema } from '../generated/browser-v1/browser/v1/interactive_pb';
import { NegotiationRequestSchema } from '../generated/browser-v1/browser/v1/negotiation_pb';
import { OperationRequestSchema } from '../generated/browser-v1/browser/v1/operations_pb';
import { CarrierEnvelopeSchema } from '../generated/browser-v1/browser/v1/transport_pb';

const fixtures = (await Bun.file(
  new URL('../../../../protocol/browser/v1/fixtures/golden.json', import.meta.url),
).json()) as Array<{
  name: string;
  messageType: string;
  protoJson: JsonValue;
  wireHex: string;
}>;

const schemas: Record<string, GenMessage<Message>> = {
  'browser.v1.Status': StatusSchema,
  'browser.v1.NegotiationRequest': NegotiationRequestSchema,
  'browser.v1.OperationRequest': OperationRequestSchema,
  'browser.v1.ApplicationEvent': ApplicationEventSchema,
  'browser.v1.InteractiveEnvelope': InteractiveEnvelopeSchema,
  'browser.v1.ControlEnvelope': ControlEnvelopeSchema,
  'browser.v1.CarrierEnvelope': CarrierEnvelopeSchema,
};

describe('browser.v1 golden fixtures', () => {
  for (const fixture of fixtures) {
    test(`${fixture.name} matches binary and canonical ProtoJSON`, () => {
      const schema = schemas[fixture.messageType];
      expect(schema).toBeDefined();

      const expected = fromJson(schema!, fixture.protoJson);
      const wire = Buffer.from(fixture.wireHex, 'hex');
      const decoded = fromBinary(schema!, wire);

      expect(toBinary(schema!, expected)).toEqual(wire);
      expect(toJson(schema!, decoded)).toEqual(toJson(schema!, expected));
    });
  }
});
