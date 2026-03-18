/**
 * Tests for ports/env-writer.ts
 *
 * Tests copying .env files between project and worktree with port overrides.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { resolve } from 'path';

import { copyAndOverrideEnv, readAllocatedPorts } from '../ports/env-writer.js';
import type { PortAllocation } from '../ports/port-allocator.js';

const TMP = resolve(import.meta.dir, '__tmp_env_writer_test__');
const PROJECT = resolve(TMP, 'project');
const WORKTREE = resolve(TMP, 'worktree');

describe('env-writer', () => {
  beforeEach(() => {
    mkdirSync(PROJECT, { recursive: true });
    mkdirSync(WORKTREE, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  describe('copyAndOverrideEnv', () => {
    test('copies .env with port overrides', () => {
      writeFileSync(
        resolve(PROJECT, '.env'),
        'API_KEY=secret\nPORT=3000\nDATABASE_URL=postgres://localhost\n',
      );

      const allocations: PortAllocation[] = [{ groupName: 'api', port: 4000, envVars: ['PORT'] }];

      copyAndOverrideEnv(PROJECT, WORKTREE, '.env', allocations);

      const content = readFileSync(resolve(WORKTREE, '.env'), 'utf-8');
      expect(content).toContain('API_KEY=secret');
      expect(content).toContain('DATABASE_URL=postgres://localhost');
      expect(content).toContain('PORT=4000');
      // Original PORT=3000 should be replaced
      expect(content).not.toContain('PORT=3000');
    });

    test('creates .env in worktree when source does not exist', () => {
      const allocations: PortAllocation[] = [
        { groupName: 'web', port: 8080, envVars: ['WEB_PORT'] },
      ];

      copyAndOverrideEnv(PROJECT, WORKTREE, '.env', allocations);

      const content = readFileSync(resolve(WORKTREE, '.env'), 'utf-8');
      expect(content).toContain('WEB_PORT=8080');
    });

    test('handles multiple port allocations', () => {
      writeFileSync(resolve(PROJECT, '.env'), 'API_PORT=3000\nDB_PORT=5432\nAPP_NAME=test\n');

      const allocations: PortAllocation[] = [
        { groupName: 'api', port: 3100, envVars: ['API_PORT'] },
        { groupName: 'db', port: 5500, envVars: ['DB_PORT'] },
      ];

      copyAndOverrideEnv(PROJECT, WORKTREE, '.env', allocations);

      const content = readFileSync(resolve(WORKTREE, '.env'), 'utf-8');
      expect(content).toContain('API_PORT=3100');
      expect(content).toContain('DB_PORT=5500');
      expect(content).toContain('APP_NAME=test');
    });

    test('preserves comments and empty lines from source', () => {
      writeFileSync(
        resolve(PROJECT, '.env'),
        '# This is a comment\nKEY=value\n\n# Another comment\nPORT=3000\n',
      );

      const allocations: PortAllocation[] = [{ groupName: 'web', port: 4000, envVars: ['PORT'] }];

      copyAndOverrideEnv(PROJECT, WORKTREE, '.env', allocations);

      const content = readFileSync(resolve(WORKTREE, '.env'), 'utf-8');
      expect(content).toContain('# This is a comment');
      expect(content).toContain('KEY=value');
    });

    test('creates nested directories for .env files', () => {
      writeFileSync(resolve(PROJECT, '.env'), 'PORT=3000\n');
      mkdirSync(resolve(PROJECT, 'apps', 'web'), { recursive: true });
      writeFileSync(resolve(PROJECT, 'apps', 'web', '.env'), 'PORT=3001\n');

      const allocations: PortAllocation[] = [{ groupName: 'web', port: 5000, envVars: ['PORT'] }];

      copyAndOverrideEnv(PROJECT, WORKTREE, 'apps/web/.env', allocations);

      expect(existsSync(resolve(WORKTREE, 'apps', 'web', '.env'))).toBe(true);
    });
  });

  describe('readAllocatedPorts', () => {
    const MARKER = '# === Funny Port Allocation (auto-generated) ===';

    test('reads allocated ports from .env', () => {
      writeFileSync(resolve(WORKTREE, '.env'), `KEY=value\n${MARKER}\nPORT=4000\nDB_PORT=5500\n`);

      const ports = readAllocatedPorts(WORKTREE, ['.env']);
      expect(ports.has(4000)).toBe(true);
      expect(ports.has(5500)).toBe(true);
      expect(ports.size).toBe(2);
    });

    test('returns empty set when no .env exists', () => {
      const ports = readAllocatedPorts(WORKTREE, ['.env']);
      expect(ports.size).toBe(0);
    });

    test('only reads ports after the marker', () => {
      writeFileSync(
        resolve(WORKTREE, '.env'),
        `PORT=3000\nOTHER=value\n${MARKER}\nALLOC_PORT=4000\n`,
      );

      const ports = readAllocatedPorts(WORKTREE, ['.env']);
      // Should only include 4000 (after marker), not 3000 (before marker)
      expect(ports.has(4000)).toBe(true);
      expect(ports.has(3000)).toBe(false);
    });

    test('reads ports from multiple .env files', () => {
      writeFileSync(resolve(WORKTREE, '.env'), `${MARKER}\nPORT=4000\n`);
      mkdirSync(resolve(WORKTREE, 'apps', 'web'), { recursive: true });
      writeFileSync(resolve(WORKTREE, 'apps', 'web', '.env'), `${MARKER}\nWEB_PORT=5000\n`);

      const ports = readAllocatedPorts(WORKTREE, ['.env', 'apps/web/.env']);
      expect(ports.has(4000)).toBe(true);
      expect(ports.has(5000)).toBe(true);
    });

    test('ignores non-numeric values after marker', () => {
      writeFileSync(
        resolve(WORKTREE, '.env'),
        `${MARKER}\n# comment\nPORT=4000\nINVALID=notanumber\n`,
      );

      const ports = readAllocatedPorts(WORKTREE, ['.env']);
      expect(ports.has(4000)).toBe(true);
      expect(ports.size).toBe(1);
    });
  });
});
