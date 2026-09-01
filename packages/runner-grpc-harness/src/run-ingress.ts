import { arch, cpus, platform, totalmem } from 'node:os';
import { resolve } from 'node:path';

const repetitions = 3;
const thresholds = {
  maxDurationMs: 30_000,
  maxBunPeakRssMiB: 256,
  maxEnvoyPeakMemoryMiB: 128,
};

interface IngressRun {
  bun: string;
  durationMs: number;
  ingress: {
    downstream: string;
    envoy: { image: string; peakCpuPercent: number; peakMemoryMiB: number };
    tls: string;
    upstream: string;
  };
  resources: {
    bunCpuMs: number;
    bunPeakRssMiB: number;
  };
  status: string;
}

async function dockerVersion(): Promise<string> {
  const child = Bun.spawn(['docker', 'version', '--format', '{{.Server.Version}}'], {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`Docker is required for the ingress gate: ${stderr}`);
  return stdout.trim();
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

const runs: IngressRun[] = [];
const docker = await dockerVersion();
for (let run = 1; run <= repetitions; run += 1) {
  const child = Bun.spawn(['bun', 'src/run-sustained.ts', '--ingress'], {
    cwd: resolve(import.meta.dir, '..'),
    stderr: 'pipe',
    stdout: 'pipe',
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 45_000);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(timeout);
  if (timedOut) throw new Error(`Ingress run ${run} exceeded 45 seconds: ${stderr}`);
  if (exitCode !== 0) throw new Error(`Ingress run ${run} failed (${exitCode}): ${stderr}`);
  const result = JSON.parse(stdout) as IngressRun;
  if (result.status !== 'passed') throw new Error(`Ingress run ${run} did not pass`);
  if (result.durationMs > thresholds.maxDurationMs) {
    throw new Error(`Ingress run ${run} exceeded ${thresholds.maxDurationMs}ms`);
  }
  if (result.resources.bunPeakRssMiB > thresholds.maxBunPeakRssMiB) {
    throw new Error(`Ingress run ${run} exceeded the Bun RSS threshold`);
  }
  if (result.ingress.envoy.peakMemoryMiB > thresholds.maxEnvoyPeakMemoryMiB) {
    throw new Error(`Ingress run ${run} exceeded the Envoy memory threshold`);
  }
  runs.push(result);
}

console.info(
  JSON.stringify({
    status: 'passed',
    repetitions,
    thresholds,
    measurements: {
      medianDurationMs: median(runs.map((run) => run.durationMs)),
      maxDurationMs: Math.max(...runs.map((run) => run.durationMs)),
      maxBunCpuMs: Math.max(...runs.map((run) => run.resources.bunCpuMs)),
      maxBunPeakRssMiB: Math.max(...runs.map((run) => run.resources.bunPeakRssMiB)),
      maxEnvoyCpuPercent: Math.max(...runs.map((run) => run.ingress.envoy.peakCpuPercent)),
      maxEnvoyPeakMemoryMiB: Math.max(...runs.map((run) => run.ingress.envoy.peakMemoryMiB)),
    },
    transport: {
      downstream: 'TLS 1.2+ / ALPN h2',
      upstream: 'HTTP/2 cleartext (h2c)',
      streamIdleTimeout: 'disabled',
      routeTimeout: 'disabled',
    },
    envoyImage: runs[0]?.ingress.envoy.image,
    environment: {
      architecture: arch(),
      bun: runs[0]?.bun,
      cpu: cpus()[0]?.model,
      docker,
      logicalCpus: cpus().length,
      platform: platform(),
      totalMemoryMiB: Math.round(totalmem() / 1024 / 1024),
    },
  }),
);
