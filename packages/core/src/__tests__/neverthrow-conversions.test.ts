import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { okAsync } from 'neverthrow';
import { vi, describe, test, expect, beforeEach } from 'vitest';

vi.mock('../git/process.js', () => ({
  executeShell: vi.fn(),
  execute: vi.fn(),
  gitRead: vi.fn(),
  gitWrite: vi.fn(),
  SHELL: 'sh',
}));

vi.mock('../ports/config-reader.js', () => ({
  readProjectConfig: vi.fn(),
}));
vi.mock('../ports/port-allocator.js', () => ({
  allocatePorts: vi.fn(),
}));
vi.mock('../ports/env-writer.js', () => ({
  copyAndOverrideEnv: vi.fn(),
  readAllocatedPorts: vi.fn(),
}));
vi.mock('../git/worktree.js', () => ({
  getWorktreeBase: vi.fn(),
}));

import { runHookCommand } from '../git/commit.js';
// Must import after mocks
import { execute, executeShell } from '../git/process.js';
import { getWorktreeBase } from '../git/worktree.js';
import { readProjectConfig } from '../ports/config-reader.js';
import { setupWorktree, syncClaudeProjectAssets } from '../ports/index.js';
import { allocatePorts } from '../ports/port-allocator.js';

const mockExecute = execute as ReturnType<typeof vi.fn>;
const mockExecuteShell = executeShell as ReturnType<typeof vi.fn>;
const mockReadProjectConfig = readProjectConfig as ReturnType<typeof vi.fn>;
const mockAllocatePorts = allocatePorts as ReturnType<typeof vi.fn>;
const mockGetWorktreeBase = getWorktreeBase as ReturnType<typeof vi.fn>;

describe('runHookCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('returns ok({ success: true, output }) when command succeeds (exit code 0)', async () => {
    mockExecute.mockResolvedValue({
      exitCode: 0,
      stdout: 'lint passed',
      stderr: '',
    });

    const result = await runHookCommand('/project', 'npm run lint');

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      success: true,
      output: 'lint passed',
    });
    expect(mockExecute).toHaveBeenCalledWith(
      'sh',
      [expect.stringMatching(/funny-hook-[\w-]+[\\/]hook\.sh$/)],
      { cwd: '/project', reject: false, timeout: 120_000 },
    );
  });

  test('returns ok({ success: false, output }) when command fails (non-zero exit code)', async () => {
    mockExecute.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'lint errors found',
    });

    const result = await runHookCommand('/project', 'npm run lint');

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      success: false,
      output: 'lint errors found',
    });
  });

  test('returns err(DomainError) when execute throws', async () => {
    mockExecute.mockRejectedValue(new Error('Command not found'));

    const result = await runHookCommand('/project', 'nonexistent-cmd');

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe('PROCESS_ERROR');
    expect(error.message).toBe('Command not found');
  });

  test('returns ok({ success: false }) for empty command', async () => {
    const result = await runHookCommand('/project', '');
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().success).toBe(false);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test('returns ok({ success: false }) for oversized command', async () => {
    const huge = 'x'.repeat(64 * 1024 + 1);
    const result = await runHookCommand('/project', huge);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().success).toBe(false);
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

describe('setupWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('returns ok(result) with empty result when no config exists', async () => {
    mockReadProjectConfig.mockReturnValue(null);

    const result = await setupWorktree('/project', '/worktree');

    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.ports).toEqual([]);
    expect(value.postCreateErrors).toEqual([]);
  });

  test('returns ok(result) with ports when config has portGroups', async () => {
    const mockPorts = [{ name: 'web', port: 3000, envVars: ['PORT'] }];

    mockReadProjectConfig.mockReturnValue({
      portGroups: [{ name: 'web', defaultPort: 3000, envVars: ['PORT'] }],
      envFiles: ['.env'],
    });
    mockGetWorktreeBase.mockReturnValue(okAsync('/worktrees'));
    mockAllocatePorts.mockResolvedValue(mockPorts);

    const result = await setupWorktree('/project', '/worktree');

    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.ports).toEqual(mockPorts);
    expect(mockAllocatePorts).toHaveBeenCalled();
  });

  test('collects postCreateErrors without failing the whole operation', async () => {
    mockReadProjectConfig.mockReturnValue({
      postCreate: ['npm install', 'broken-cmd'],
    });

    mockExecuteShell
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // npm install succeeds
      .mockRejectedValueOnce(new Error('broken-cmd failed')); // broken-cmd throws

    const result = await setupWorktree('/project', '/worktree');

    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.postCreateErrors).toHaveLength(1);
    expect(value.postCreateErrors[0]).toContain('broken-cmd');
    expect(value.postCreateErrors[0]).toContain('broken-cmd failed');
  });

  test('returns err(DomainError) when port allocation throws', async () => {
    mockReadProjectConfig.mockReturnValue({
      portGroups: [{ name: 'web', defaultPort: 3000, envVars: ['PORT'] }],
      envFiles: ['.env'],
    });
    mockGetWorktreeBase.mockReturnValue(okAsync('/worktrees'));
    mockAllocatePorts.mockRejectedValue(new Error('No ports available'));

    const result = await setupWorktree('/project', '/worktree');

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe('INTERNAL');
    expect(error.message).toContain('Worktree setup failed');
  });
});

describe('syncClaudeProjectAssets', () => {
  test('copies project Claude commands and skills into a worktree', () => {
    const root = mkdtempSync(join(tmpdir(), 'funny-claude-assets-'));
    const projectPath = join(root, 'project');
    const worktreePath = join(root, 'worktree');

    try {
      mkdirSync(join(projectPath, '.claude', 'commands', 'opsx'), { recursive: true });
      mkdirSync(join(projectPath, '.claude', 'skills', 'review'), { recursive: true });
      writeFileSync(join(projectPath, '.claude', 'commands', 'opsx', 'apply.md'), 'apply');
      writeFileSync(join(projectPath, '.claude', 'skills', 'review', 'SKILL.md'), 'review');

      syncClaudeProjectAssets(projectPath, worktreePath);

      expect(
        readFileSync(join(worktreePath, '.claude', 'commands', 'opsx', 'apply.md'), 'utf8'),
      ).toBe('apply');
      expect(
        readFileSync(join(worktreePath, '.claude', 'skills', 'review', 'SKILL.md'), 'utf8'),
      ).toBe('review');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does nothing when the project has no Claude assets', () => {
    const root = mkdtempSync(join(tmpdir(), 'funny-claude-assets-empty-'));
    const projectPath = join(root, 'project');
    const worktreePath = join(root, 'worktree');

    try {
      syncClaudeProjectAssets(projectPath, worktreePath);

      expect(existsSync(join(worktreePath, '.claude'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
