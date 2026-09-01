import { fromJson, toBinary } from '@bufbuild/protobuf';
import type { GenMessage, Message } from '@bufbuild/protobuf/codegenv2';

import { FailureSchema } from '../packages/shared/src/generated/runner-v2/runner/v2/common_pb.ts';
import { RunnerHelloSchema } from '../packages/shared/src/generated/runner-v2/runner/v2/control_pb.ts';
import { EventsResponseSchema } from '../packages/shared/src/generated/runner-v2/runner/v2/events_pb.ts';
import { OperationsRequestSchema } from '../packages/shared/src/generated/runner-v2/runner/v2/operations_pb.ts';
import { TerminalRequestSchema } from '../packages/shared/src/generated/runner-v2/runner/v2/terminal_pb.ts';
import { TunnelRequestSchema } from '../packages/shared/src/generated/runner-v2/runner/v2/tunnel_pb.ts';

const fixturePath = new URL('../protocol/runner/v2/fixtures/golden.json', import.meta.url);
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
