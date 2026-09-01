import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connect } from 'node:tls';

const envoyImage =
  'envoyproxy/envoy@sha256:127e33c48c60be9a148cf9256d52e734ceda28aa344145023933116c7e524beb';

interface DockerStats {
  CPUPerc?: string;
  MemUsage?: string;
}

export interface IngressMeasurements {
  image: string;
  peakCpuPercent: number;
  peakMemoryMiB: number;
  samples: number;
}

export interface EnvoyIngress {
  logs(): Promise<string>;
  port: number;
  stop(): Promise<IngressMeasurements>;
}

function envoyConfig(backendPort: number): string {
  return `static_resources:
  listeners:
    - name: public_grpc
      address:
        socket_address: { address: 0.0.0.0, port_value: 8443 }
      filter_chains:
        - transport_socket:
            name: envoy.transport_sockets.tls
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext
              common_tls_context:
                tls_params:
                  tls_minimum_protocol_version: TLSv1_2
                  tls_maximum_protocol_version: TLSv1_3
                alpn_protocols: [h2]
                tls_certificates:
                  - certificate_chain: { filename: /fixtures/server-cert.pem }
                    private_key: { filename: /fixtures/server-key.pem }
          filters:
            - name: envoy.filters.network.http_connection_manager
              typed_config:
                "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
                stat_prefix: ingress_grpc
                codec_type: HTTP2
                stream_idle_timeout: 0s
                http2_protocol_options:
                  max_concurrent_streams: 100
                route_config:
                  name: runner_routes
                  virtual_hosts:
                    - name: runner
                      domains: ["*"]
                      routes:
                        - match: { prefix: "/runner.v2.RunnerTransportService/" }
                          route:
                            cluster: bun_grpc
                            timeout: 0s
                http_filters:
                  - name: envoy.filters.http.router
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router
  clusters:
    - name: bun_grpc
      connect_timeout: 2s
      type: STRICT_DNS
      load_assignment:
        cluster_name: bun_grpc
        endpoints:
          - lb_endpoints:
              - endpoint:
                  address:
                    socket_address:
                      address: host.docker.internal
                      port_value: ${backendPort}
      typed_extension_protocol_options:
        envoy.extensions.upstreams.http.v3.HttpProtocolOptions:
          "@type": type.googleapis.com/envoy.extensions.upstreams.http.v3.HttpProtocolOptions
          explicit_http_config:
            http2_protocol_options: {}
`;
}

async function command(
  arguments_: string[],
): Promise<{ code: number; stderr: string; stdout: string }> {
  const process = Bun.spawn(arguments_, { stderr: 'pipe', stdout: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

async function waitForTls(port: number, containerId: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = await command([
      'docker',
      'inspect',
      '--format',
      '{{.State.Running}}',
      containerId,
    ]);
    if (state.code !== 0 || state.stdout.trim() !== 'true') {
      throw new Error('Envoy ingress exited before becoming ready');
    }
    const connected = await new Promise<boolean>((resolveConnected) => {
      const socket = connect({
        ALPNProtocols: ['h2'],
        host: '127.0.0.1',
        port,
        rejectUnauthorized: false,
        servername: 'localhost',
      });
      socket.once('secureConnect', () => {
        const negotiatedHttp2 = socket.alpnProtocol === 'h2';
        socket.destroy();
        resolveConnected(negotiatedHttp2);
      });
      socket.once('error', () => resolveConnected(false));
    });
    if (connected) return;
    await Bun.sleep(50);
  }
  throw new Error(`Envoy ingress did not listen on port ${port} within 10 seconds`);
}

function parseMemoryMiB(value: string): number {
  const match = value.trim().match(/^([0-9.]+)([KMG]i?B)/i);
  if (!match) return 0;
  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  if (unit === 'kib' || unit === 'kb') return amount / 1024;
  if (unit === 'gib' || unit === 'gb') return amount * 1024;
  return amount;
}

export async function startEnvoyIngress(
  backendPort: number,
  fixturesDirectory: string,
): Promise<EnvoyIngress> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'funny-grpc-ingress-'));
  const configPath = join(temporaryDirectory, 'envoy.yaml');
  await writeFile(configPath, envoyConfig(backendPort));

  const started = await command([
    'docker',
    'run',
    '--detach',
    '--add-host',
    'host.docker.internal:host-gateway',
    '--publish',
    '127.0.0.1::8443',
    '--volume',
    `${configPath}:/etc/envoy/envoy.yaml:ro`,
    '--volume',
    `${resolve(fixturesDirectory)}:/fixtures:ro`,
    envoyImage,
    '-c',
    '/etc/envoy/envoy.yaml',
    '--log-level',
    'warning',
  ]);
  if (started.code !== 0) {
    await rm(temporaryDirectory, { force: true, recursive: true });
    throw new Error(`Could not start Envoy ingress: ${started.stderr.trim()}`);
  }
  const containerId = started.stdout.trim();

  const mapped = await command(['docker', 'port', containerId, '8443/tcp']);
  if (mapped.code !== 0) {
    await command(['docker', 'rm', '--force', containerId]);
    await rm(temporaryDirectory, { force: true, recursive: true });
    throw new Error(`Could not resolve Envoy ingress port: ${mapped.stderr.trim()}`);
  }
  const portMatch = mapped.stdout.trim().match(/:(\d+)$/);
  if (!portMatch) {
    await command(['docker', 'rm', '--force', containerId]);
    await rm(temporaryDirectory, { force: true, recursive: true });
    throw new Error(`Unexpected Docker port output: ${mapped.stdout.trim()}`);
  }
  const port = Number(portMatch[1]);

  try {
    await waitForTls(port, containerId);
  } catch (error) {
    const logs = await command(['docker', 'logs', containerId]);
    await command(['docker', 'rm', '--force', containerId]);
    await rm(temporaryDirectory, { force: true, recursive: true });
    throw new Error(`${String(error)}\n${logs.stderr.trim()}`, { cause: error });
  }

  let sampling = true;
  const samples: DockerStats[] = [];
  const sampler = (async () => {
    while (sampling) {
      const result = await command([
        'docker',
        'stats',
        '--no-stream',
        '--format',
        '{{json .}}',
        containerId,
      ]);
      if (result.code === 0 && result.stdout.trim()) {
        samples.push(JSON.parse(result.stdout.trim()) as DockerStats);
      }
      await Bun.sleep(100);
    }
  })();

  return {
    async logs() {
      const result = await command(['docker', 'logs', containerId]);
      return `${result.stdout}${result.stderr}`.trim();
    },
    port,
    async stop() {
      sampling = false;
      await sampler;
      const removed = await command(['docker', 'rm', '--force', containerId]);
      await rm(temporaryDirectory, { force: true, recursive: true });
      if (removed.code !== 0 && !removed.stderr.includes('No such container')) {
        throw new Error(`Could not stop Envoy ingress: ${removed.stderr.trim()}`);
      }
      return {
        image: envoyImage,
        peakCpuPercent: Math.max(
          0,
          ...samples.map((sample) => Number.parseFloat(sample.CPUPerc ?? '0')),
        ),
        peakMemoryMiB: Math.max(
          0,
          ...samples.map((sample) => parseMemoryMiB(sample.MemUsage?.split('/')[0] ?? '0B')),
        ),
        samples: samples.length,
      };
    },
  };
}
