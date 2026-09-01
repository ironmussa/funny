import { describe, expect, test } from 'bun:test';

import { fromBinary, fromJson, toBinary, toJson } from '@bufbuild/protobuf';
import type { JsonValue, Message } from '@bufbuild/protobuf';
import type { GenMessage } from '@bufbuild/protobuf/codegenv2';

import { FailureSchema } from '../generated/runner-v2/runner/v2/common_pb';
import { RunnerHelloSchema } from '../generated/runner-v2/runner/v2/control_pb';
import { EventsResponseSchema } from '../generated/runner-v2/runner/v2/events_pb';
import { OperationsRequestSchema } from '../generated/runner-v2/runner/v2/operations_pb';
import { TerminalRequestSchema } from '../generated/runner-v2/runner/v2/terminal_pb';
import { TunnelRequestSchema } from '../generated/runner-v2/runner/v2/tunnel_pb';

const fixturePath = new URL('../../../../protocol/runner/v2/fixtures/golden.json', import.meta.url);
const schemas: Record<string, GenMessage<Message>> = {
  'runner.v2.RunnerHello': RunnerHelloSchema,
  'runner.v2.Failure': FailureSchema,
  'runner.v2.TunnelRequest': TunnelRequestSchema,
  'runner.v2.OperationsRequest': OperationsRequestSchema,
  'runner.v2.EventsResponse': EventsResponseSchema,
  'runner.v2.TerminalRequest': TerminalRequestSchema,
};

interface GoldenFixture {
  name: string;
  messageType: string;
  protoJson: JsonValue;
  wireHex: string;
}

const fixtures = (await Bun.file(fixturePath).json()) as GoldenFixture[];

describe('runner.v2 golden wire fixtures', () => {
  for (const fixture of fixtures) {
    test(fixture.name, () => {
      const schema = schemas[fixture.messageType];
      expect(schema).toBeDefined();

      const expectedWire = Uint8Array.from(Buffer.from(fixture.wireHex, 'hex'));
      const fromFixtureJson = fromJson(schema, fixture.protoJson);
      expect(toBinary(schema, fromFixtureJson)).toEqual(expectedWire);

      const decoded = fromBinary(schema, expectedWire);
      expect(toJson(schema, decoded)).toEqual(fixture.protoJson);
      expect(toBinary(schema, decoded)).toEqual(expectedWire);
    });
  }
});
