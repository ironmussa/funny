import { resolve } from 'node:path';

import * as grpc from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';

import { startEnvoyIngress, type EnvoyIngress } from './envoy-ingress';

const runnerToken = 'runner-grpc-harness-token';
const packageRoot = resolve(import.meta.dir, '..');
const repositoryRoot = resolve(packageRoot, '..', '..');
const certificatePath = resolve(packageRoot, 'fixtures', 'server-cert.pem');
const privateKeyPath = resolve(packageRoot, 'fixtures', 'server-key.pem');
const protocolPath = resolve(repositoryRoot, 'protocol', 'runner', 'v2', 'control.proto');
const maxFrameBytes = 65_536;
const floodFrameCount = 128;
const useIngress = process.argv.includes('--ingress');
const soakMinutes = process.argv.includes('--soak')
  ? Number(process.env.RUNNER_GRPC_SOAK_MINUTES ?? 20)
  : 0;
if (soakMinutes !== 0 && (!Number.isFinite(soakMinutes) || soakMinutes < 15 || soakMinutes > 30)) {
  throw new Error('RUNNER_GRPC_SOAK_MINUTES must be between 15 and 30');
}
const clientDurationSeconds = Math.round(soakMinutes * 60);
const maximumRssMiB = Number(process.env.RUNNER_GRPC_MAX_RSS_MIB ?? 512);
const maximumRssGrowthMiB = Number(process.env.RUNNER_GRPC_MAX_RSS_GROWTH_MIB ?? 128);

type Message = Record<string, any>;
type Call = grpc.ServerDuplexStream<Message, Message>;

const observations = {
  deadlineCancelled: false,
  explicitCancellation: false,
  slowReaderBackpressured: false,
  forcedDisconnects: 0,
  classMessages: new Set<string>(),
  activeCalls: 0,
  maximumActiveCalls: 0,
};

function trackCall(call: Call): void {
  observations.activeCalls += 1;
  observations.maximumActiveCalls = Math.max(
    observations.maximumActiveCalls,
    observations.activeCalls,
  );
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    observations.activeCalls -= 1;
  };
  call.once('cancelled', release);
  call.once('close', release);
  call.once('error', release);
}

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
  return (v2.RunnerTransportService as grpc.ServiceClientConstructor).service;
}

function authenticate(call: Call): boolean {
  if (call.metadata.get('authorization')[0] === `Bearer ${runnerToken}`) return true;
  call.emit(
    'error',
    Object.assign(new Error('invalid runner metadata'), {
      code: grpc.status.UNAUTHENTICATED,
      details: 'invalid runner metadata',
    }),
  );
  return false;
}

function control(call: Call): void {
  if (!authenticate(call)) return;
  trackCall(call);
  call.on('data', (request: Message) => {
    observations.classMessages.add('control');
    const ordinal = request.heartbeat?.ordinal;
    if (ordinal === '99') {
      observations.forcedDisconnects += 1;
      call.emit(
        'error',
        Object.assign(new Error('injected disconnect'), {
          code: grpc.status.UNAVAILABLE,
          details: 'injected disconnect',
        }),
      );
      return;
    }
    call.write({ heartbeat: { acknowledgedOrdinal: ordinal } });
  });
}

function operations(call: Call): void {
  if (!authenticate(call)) return;
  trackCall(call);
  call.sendMetadata(new grpc.Metadata());
  let deadlineRequest = false;
  call.on('cancelled', () => {
    if (deadlineRequest) observations.deadlineCancelled = true;
  });
  call.on('data', (request: Message) => {
    observations.classMessages.add('operations');
    const correlationId = request.metadata?.correlationId;
    if (correlationId === 'deadline') {
      deadlineRequest = true;
      return;
    }
    call.write({
      session: request.session,
      correlationId,
      success: { acknowledgement: {} },
    });
  });
}

function events(call: Call): void {
  if (!authenticate(call)) return;
  trackCall(call);
  call.on('data', (request: Message) => {
    observations.classMessages.add('events');
    call.write({
      session: request.session,
      scope: request.scope,
      accepted: { highestContiguousSequence: request.sequence },
    });
    if (request.sequence === '999') {
      const trailers = new grpc.Metadata();
      trailers.set('x-harness-trailer', 'events-complete');
      call.end(trailers);
    }
  });
}

function tunnel(call: Call): void {
  if (!authenticate(call)) return;
  trackCall(call);
  call.sendMetadata(new grpc.Metadata());
  call.on('data', (request: Message) => {
    observations.classMessages.add('tunnel');
    const data = request.data?.data as Buffer | undefined;
    if (data && data.byteLength > maxFrameBytes) {
      call.emit(
        'error',
        Object.assign(new Error('frame exceeds negotiated limit'), {
          code: grpc.status.RESOURCE_EXHAUSTED,
          details: 'frame exceeds negotiated limit',
        }),
      );
      return;
    }
    if (!request.ready) return;
    for (let sequence = 1; sequence <= floodFrameCount; sequence += 1) {
      const accepted = call.write({
        session: request.session,
        tunnelId: request.tunnelId,
        data: { sequence: String(sequence), data: Buffer.alloc(maxFrameBytes, sequence) },
      });
      if (!accepted) observations.slowReaderBackpressured = true;
    }
  });
}

function terminal(call: Call): void {
  if (!authenticate(call)) return;
  trackCall(call);
  let cancellable = false;
  call.on('cancelled', () => {
    if (cancellable) observations.explicitCancellation = true;
  });
  call.on('data', (request: Message) => {
    observations.classMessages.add('terminal');
    cancellable ||= request.terminalId === 'cancel-me';
    call.write({
      session: request.session,
      terminalId: request.terminalId,
      close: { reason: 'harness acknowledgement' },
    });
  });
}

async function bindGrpcServer(server: grpc.Server): Promise<number> {
  if (useIngress) {
    return await new Promise<number>((resolvePort, reject) => {
      server.bindAsync('0.0.0.0:0', grpc.ServerCredentials.createInsecure(), (error, port) => {
        if (error) reject(error);
        else resolvePort(port);
      });
    });
  }
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
  fetch: () => Response.json({ status: 'ok', transport: 'http' }),
});
const grpcServer = new grpc.Server({
  'grpc.keepalive_time_ms': 200,
  'grpc.keepalive_timeout_ms': 1_000,
  'grpc.http2.min_ping_interval_without_data_ms': 100,
});
grpcServer.addService(loadRunnerService(), { control, operations, events, tunnel, terminal });

let ingress: EnvoyIngress | undefined;
let memorySampler: ReturnType<typeof setInterval> | undefined;
try {
  const grpcPort = await bindGrpcServer(grpcServer);
  if (useIngress) ingress = await startEnvoyIngress(grpcPort, resolve(packageRoot, 'fixtures'));
  const startedAt = performance.now();
  const cpuStarted = process.cpuUsage();
  const initialRss = process.memoryUsage.rss();
  let bunPeakRss = initialRss;
  memorySampler = setInterval(() => {
    bunPeakRss = Math.max(bunPeakRss, process.memoryUsage.rss());
  }, 20);
  const client = Bun.spawn(
    [
      'cargo',
      'run',
      '--locked',
      '--quiet',
      '--manifest-path',
      resolve(repositoryRoot, 'packages', 'runner-protocol-rust', 'Cargo.toml'),
      '--bin',
      'grpc-sustained-client',
      '--',
      `https://127.0.0.1:${ingress?.port ?? grpcPort}`,
      certificatePath,
      runnerToken,
      String(clientDurationSeconds),
    ],
    { cwd: repositoryRoot, stdout: 'pipe', stderr: 'pipe' },
  );
  let clientTimedOut = false;
  const clientTimeout = setTimeout(
    () => {
      clientTimedOut = true;
      client.kill();
    },
    (clientDurationSeconds + 30) * 1_000,
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    client.exited,
    new Response(client.stdout).text(),
    new Response(client.stderr).text(),
  ]);
  clearTimeout(clientTimeout);
  if (clientTimedOut) {
    throw new Error(`Tonic sustained client exceeded its time budget: ${stderr.trim()}`);
  }
  if (exitCode !== 0) {
    const ingressLogs = ingress ? `\nEnvoy logs:\n${await ingress.logs()}` : '';
    throw new Error(`Tonic sustained client failed (${exitCode}): ${stderr}${ingressLogs}`);
  }

  await Bun.sleep(100);
  const expectedClasses = ['control', 'operations', 'events', 'tunnel', 'terminal'];
  const missingClasses = expectedClasses.filter((name) => !observations.classMessages.has(name));
  if (missingClasses.length > 0)
    throw new Error(`missing class progress: ${missingClasses.join(', ')}`);
  if (!observations.deadlineCancelled) throw new Error('deadline cancellation was not observed');
  if (!observations.explicitCancellation) throw new Error('explicit cancellation was not observed');
  if (!observations.slowReaderBackpressured)
    throw new Error('slow reader did not apply backpressure');
  const result = JSON.parse(stdout) as Record<string, unknown>;
  const iterations = Number(result.iterations ?? 1);
  if (observations.forcedDisconnects !== iterations)
    throw new Error(`forced disconnect count ${observations.forcedDisconnects} != ${iterations}`);
  if (observations.activeCalls !== 0)
    throw new Error(`stream backlog did not drain: ${observations.activeCalls} calls remain`);
  if (observations.maximumActiveCalls > 20)
    throw new Error(`stream backlog exceeded bound: ${observations.maximumActiveCalls}`);

  const health = await fetch(`http://127.0.0.1:${httpServer.port}/health`);
  if (!health.ok) throw new Error(`coexisting HTTP listener returned ${health.status}`);
  clearInterval(memorySampler);
  memorySampler = undefined;
  const finalRss = process.memoryUsage.rss();
  const peakRssMiB = bunPeakRss / 1024 / 1024;
  const rssGrowthMiB = (finalRss - initialRss) / 1024 / 1024;
  if (peakRssMiB > maximumRssMiB) {
    throw new Error(`Bun RSS ${peakRssMiB.toFixed(1)} MiB exceeded ${maximumRssMiB} MiB`);
  }
  if (rssGrowthMiB > maximumRssGrowthMiB) {
    throw new Error(
      `Bun RSS growth ${rssGrowthMiB.toFixed(1)} MiB exceeded ${maximumRssGrowthMiB} MiB`,
    );
  }
  const cpu = process.cpuUsage(cpuStarted);
  const ingressMeasurements = await ingress?.stop();
  ingress = undefined;
  console.info(
    JSON.stringify({
      status: 'passed',
      bun: Bun.version,
      durationMs: Math.round(performance.now() - startedAt),
      profile: soakMinutes
        ? { kind: 'chaos-soak', minutes: soakMinutes, iterations }
        : { kind: 'sustained-smoke', iterations },
      classes: expectedClasses,
      server: {
        deadlineCancellation: true,
        explicitCancellation: true,
        slowReaderBackpressure: true,
        forcedDisconnects: observations.forcedDisconnects,
        maximumActiveCalls: observations.maximumActiveCalls,
        activeCallsAfterRun: observations.activeCalls,
      },
      client: result,
      resources: {
        bunCpuMs: Math.round((cpu.system + cpu.user) / 1_000),
        bunPeakRssMiB: Math.round(peakRssMiB * 10) / 10,
        bunRssGrowthMiB: Math.round(rssGrowthMiB * 10) / 10,
      },
      ...(ingressMeasurements && {
        ingress: {
          downstream: 'HTTP/2',
          envoy: ingressMeasurements,
          tls: 'TLS 1.2+ with ALPN h2',
          upstream: 'HTTP/2 cleartext (h2c)',
        },
      }),
    }),
  );
} finally {
  if (memorySampler) clearInterval(memorySampler);
  let ingressCleanupError: unknown;
  if (ingress) {
    try {
      await ingress.stop();
    } catch (error) {
      ingressCleanupError = error;
    }
  }
  httpServer.stop(true);
  await shutdownGrpcServer(grpcServer);
  if (ingressCleanupError)
    console.error('Envoy cleanup failed after harness failure', ingressCleanupError);
}
