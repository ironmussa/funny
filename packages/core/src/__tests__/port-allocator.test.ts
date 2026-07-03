/**
 * Tests for ports/port-allocator.ts
 *
 * Tests port availability checking and allocation logic.
 */
import { describe, test, expect } from 'bun:test';
import { createServer, type Server } from 'net';

import { isPortAvailable, findAvailablePort, allocatePorts } from '../ports/port-allocator.js';

async function bindEphemeralPort(): Promise<
  { port: number; close: () => Promise<void> } | undefined
> {
  const server = createServer();

  return await new Promise((resolve) => {
    server.once('error', () => {
      resolve(undefined);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => resolve(undefined));
        return;
      }

      resolve({
        port: address.port,
        close: () => closeServer(server),
      });
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe('port-allocator', () => {
  describe('isPortAvailable', () => {
    test('returns true for an available port', async () => {
      const bound = await bindEphemeralPort();
      if (!bound) return;

      await bound.close();
      const available = await isPortAvailable(bound.port);
      expect(available).toBe(true);
    });

    test('returns false for a port in use', async () => {
      const bound = await bindEphemeralPort();
      if (!bound) return;

      try {
        const available = await isPortAvailable(bound.port);
        expect(available).toBe(false);
      } finally {
        await bound.close();
      }
    });
  });

  describe('findAvailablePort', () => {
    test('returns the base port when it is available', async () => {
      const port = await findAvailablePort(59200, new Set(), async () => true);
      expect(port).toBe(59200);
    });

    test('skips excluded ports', async () => {
      const port = await findAvailablePort(59300, new Set([59300, 59301]), async () => true);
      expect(port).toBe(59302);
    });

    test('skips ports that are in use', async () => {
      const unavailablePorts = new Set([59400]);

      const port = await findAvailablePort(
        59400,
        new Set(),
        async (candidate) => !unavailablePorts.has(candidate),
      );

      expect(port).toBe(59401);
    });

    test('throws when no port found in scan range', async () => {
      // Exclude all ports in the scan range (100 ports)
      const exclude = new Set<number>();
      for (let i = 0; i < 100; i++) {
        exclude.add(65400 + i);
      }

      await expect(findAvailablePort(65400, exclude, async () => true)).rejects.toThrow(
        /Could not find available port/,
      );
    });
  });

  describe('allocatePorts', () => {
    test('allocates ports for multiple groups', async () => {
      const groups = [
        { name: 'api', basePort: 59500, envVars: ['API_PORT'] },
        { name: 'db', basePort: 59600, envVars: ['DB_PORT'] },
      ];

      const allocations = await allocatePorts(groups, new Set(), async () => true);

      expect(allocations).toHaveLength(2);
      expect(allocations[0].groupName).toBe('api');
      expect(allocations[0].port).toBe(59500);
      expect(allocations[0].envVars).toEqual(['API_PORT']);
      expect(allocations[1].groupName).toBe('db');
      expect(allocations[1].port).toBe(59600);
    });

    test('avoids already excluded ports', async () => {
      const groups = [{ name: 'web', basePort: 59700, envVars: ['WEB_PORT'] }];
      const exclude = new Set([59700]);

      const allocations = await allocatePorts(groups, exclude, async () => true);
      expect(allocations[0].port).toBe(59701);
    });

    test('avoids collisions between groups', async () => {
      // Both groups have the same base port — second should auto-increment
      const groups = [
        { name: 'frontend', basePort: 59800, envVars: ['FRONTEND_PORT'] },
        { name: 'backend', basePort: 59800, envVars: ['BACKEND_PORT'] },
      ];

      const allocations = await allocatePorts(groups, new Set(), async () => true);
      expect(allocations[0].port).toBe(59800);
      expect(allocations[1].port).toBe(59801);
      expect(allocations[0].port).not.toBe(allocations[1].port);
    });

    test('returns empty array for no groups', async () => {
      const allocations = await allocatePorts([]);
      expect(allocations).toEqual([]);
    });

    test('handles groups with multiple env vars', async () => {
      const groups = [
        { name: 'service', basePort: 59900, envVars: ['PORT', 'SERVICE_PORT', 'APP_PORT'] },
      ];

      const allocations = await allocatePorts(groups, new Set(), async () => true);
      expect(allocations[0].envVars).toEqual(['PORT', 'SERVICE_PORT', 'APP_PORT']);
    });
  });
});
