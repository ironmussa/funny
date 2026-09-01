import { resolve } from 'node:path';

import * as grpc from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';

const runnerToken = 'runner-grpc-harness-token';
const packageRoot = resolve(import.meta.dir, '..');
const repositoryRoot = resolve(packageRoot, '..', '..');
const certificatePath = resolve(packageRoot, 'fixtures', 'server-cert.pem');
const privateKeyPath = resolve(packageRoot, 'fixtures', 'server-key.pem');
const protocolPath = resolve(repositoryRoot, 'protocol', 'runner', 'v2', 'control.proto');

type ControlMessage = Record<string, unknown>;
type ControlCall = grpc.ServerDuplexStream<ControlMessage, ControlMessage>;

function loadRunnerService(): grpc.ServiceDefinition {
  const definition = loadSync(protocolPath, {
    defaults: false,
    enums: String,
    keepCase: false,
    longs: String,
    oneofs: true,
    includeDirs: [resolve(repositoryRoot, 'protocol')],
  });
  const root = grpc.loadPackageDefinition(definition) as grpc.GrpcObject;
  const runner = root.runner as grpc.GrpcObject;
  const v2 = runner.v2 as grpc.GrpcObject;
  const constructor = v2.RunnerTransportService as grpc.ServiceClientConstructor;
  return constructor.service;
}

function control(call: ControlCall): void {
  const authorization = call.metadata.get('authorization')[0];
  if (authorization !== `Bearer ${runnerToken}`) {
    const error = Object.assign(new Error('invalid runner metadata'), {
      code: grpc.status.UNAUTHENTICATED,
      details: 'invalid runner metadata',
    });
    call.destroy(error);
    return;
  }

  let negotiated = false;
  call.on('data', (request: ControlMessage) => {
    if (negotiated || request.message !== 'hello') return;
    negotiated = true;

    const metadata = new grpc.Metadata();
    metadata.set('x-harness-authenticated-runner', 'runner-harness');
    call.sendMetadata(metadata);
    call.write({
      hello: {
        selectedVersion: { major: 2, minor: 0 },
        sessionEpoch: '1',
        enabledCapabilities: ['RUNNER_CAPABILITY_OPERATIONS'],
        effectiveLimits: {
          maxMessageBytes: 4_194_304,
          maxFrameBytes: 65_536,
          maxPendingOperations: 8,
          maxActiveTunnels: 2,
          maxActiveTerminals: 2,
          maxBufferedBytesPerClass: '1048576',
        },
        heartbeatInterval: { seconds: '5' },
        heartbeatTimeout: { seconds: '15' },
      },
    });
    call.end();
  });
}

async function bindGrpcServer(server: grpc.Server): Promise<number> {
  const certificate = Buffer.from(await Bun.file(certificatePath).arrayBuffer());
  const privateKey = Buffer.from(await Bun.file(privateKeyPath).arrayBuffer());
  const credentials = grpc.ServerCredentials.createSsl(null, [
    { cert_chain: certificate, private_key: privateKey },
  ]);
  return await new Promise<number>((resolvePort, reject) => {
    server.bindAsync('127.0.0.1:0', credentials, (error, port) => {
      if (error) reject(error);
      else resolvePort(port);
    });
  });
}

async function shutdownGrpcServer(server: grpc.Server): Promise<void> {
  await new Promise<void>((resolveShutdown, reject) => {
    server.tryShutdown((error) => {
      if (error) reject(error);
      else resolveShutdown();
    });
  });
}

const httpServer = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ status: 'ok', transport: 'http' });
    return new Response('not found', { status: 404 });
  },
});

const grpcServer = new grpc.Server();
grpcServer.addService(loadRunnerService(), { control });

try {
  const grpcPort = await bindGrpcServer(grpcServer);
  const health = await fetch(`http://127.0.0.1:${httpServer.port}/health`);
  if (!health.ok) throw new Error(`coexisting HTTP listener returned ${health.status}`);

  const client = Bun.spawn(
    [
      'cargo',
      'run',
      '--locked',
      '--quiet',
      '--manifest-path',
      resolve(repositoryRoot, 'packages', 'runner-protocol-rust', 'Cargo.toml'),
      '--bin',
      'grpc-compat-client',
      '--',
      `https://127.0.0.1:${grpcPort}`,
      certificatePath,
      runnerToken,
    ],
    { cwd: repositoryRoot, stdout: 'pipe', stderr: 'pipe' },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    client.exited,
    new Response(client.stdout).text(),
    new Response(client.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`Tonic client failed (${exitCode}): ${stderr.trim()}`);

  const result = JSON.parse(stdout) as {
    authenticatedRunner?: string;
    protocolMajor?: number;
  };
  if (result.authenticatedRunner !== 'runner-harness' || result.protocolMajor !== 2) {
    throw new Error(`unexpected Tonic result: ${stdout.trim()}`);
  }

  console.info(
    JSON.stringify({
      status: 'passed',
      bun: Bun.version,
      grpcPort,
      httpPort: httpServer.port,
      ...result,
    }),
  );
} finally {
  httpServer.stop(true);
  await shutdownGrpcServer(grpcServer);
}
