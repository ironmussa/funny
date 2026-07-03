import { createServer } from 'net';

import type { FunnyPortGroup } from '@funny/shared';

const MAX_SCAN_RANGE = 100;

export interface PortAllocation {
  groupName: string;
  port: number;
  envVars: string[];
}

type PortAvailabilityChecker = (port: number) => Promise<boolean>;

export function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.on('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

export async function findAvailablePort(
  basePort: number,
  exclude: Set<number>,
  isAvailable: PortAvailabilityChecker = isPortAvailable,
): Promise<number> {
  for (let offset = 0; offset < MAX_SCAN_RANGE; offset++) {
    const candidate = basePort + offset;
    if (candidate > 65535) break;
    if (exclude.has(candidate)) continue;
    if (await isAvailable(candidate)) return candidate;
  }
  throw new Error(
    `Could not find available port near ${basePort} (scanned ${MAX_SCAN_RANGE} ports)`,
  );
}

export async function allocatePorts(
  groups: FunnyPortGroup[],
  exclude: Set<number> = new Set(),
  isAvailable: PortAvailabilityChecker = isPortAvailable,
): Promise<PortAllocation[]> {
  const allocated: PortAllocation[] = [];
  const usedPorts = new Set(exclude);

  for (const group of groups) {
    const port = await findAvailablePort(group.basePort, usedPorts, isAvailable);
    usedPorts.add(port);
    allocated.push({
      groupName: group.name,
      port,
      envVars: group.envVars,
    });
  }

  return allocated;
}
