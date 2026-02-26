import { existsSync } from 'node:fs';

import { processError, internal, type DomainError } from '@funny/shared/errors';
import { ResultAsync } from 'neverthrow';
import pLimit from 'p-limit';

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Cross-platform shell: Git Bash on Windows, sh elsewhere.
 *
 * On Windows, bare `bash` can resolve to WSL's bash (C:\Windows\System32\bash.exe)
 * instead of Git Bash, producing /mnt/c/ paths and a broken environment (no node,
 * bun, gh, etc.). We resolve Git Bash explicitly via its standard install path.
 */
function resolveShell(): string {
  if (process.platform !== 'win32') return 'sh';

  // Try the standard Git for Windows install path first
  const gitBashPaths = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ];
  for (const p of gitBashPaths) {
    if (existsSync(p)) return p;
  }

  // Fallback: hope the right bash is first in PATH
  return 'bash';
}

export const SHELL = resolveShell();

/**
 * Execute a shell command string cross-platform.
 * Wraps the command in `bash -c` (Windows) or `sh -c` (Unix).
 */
export async function executeShell(
  command: string,
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  return execute(SHELL, ['-c', command], options);
}

export interface ProcessOptions {
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
  reject?: boolean; // false = don't throw on non-zero exit
  stdin?: string; // data to write to stdin
  /** Skip the concurrency pool (e.g. for critical single-shot commands). */
  skipPool?: boolean;
}

export class ProcessExecutionError extends Error {
  constructor(
    message: string,
    public exitCode: number,
    public stdout: string,
    public stderr: string,
    public command: string,
  ) {
    super(message);
    this.name = 'ProcessExecutionError';
  }
}

// Limits how many git/child processes run at once.
// Each getStatusSummary() spawns up to 6 processes per worktree thread (in 3 parallel phases); without a
// cap, a page load with many projects can spawn 200+ processes simultaneously.
const processPool = pLimit(6);

/**
 * Execute a command asynchronously with proper error handling.
 * Respects the global concurrency pool unless options.skipPool is set.
 */
export async function execute(
  command: string,
  args: string[],
  options: ProcessOptions = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (options.skipPool) return _executeRaw(command, args, options);
  return processPool(() => _executeRaw(command, args, options));
}

async function _executeRaw(
  command: string,
  args: string[],
  options: ProcessOptions,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : undefined,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: options.stdin != null ? new Blob([options.stdin]) : undefined,
  });

  const timeoutMs = options.timeout ?? 30_000;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      proc.kill();
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command} ${args.join(' ')}`));
    }, timeoutMs);
  });

  try {
    // Read streams BEFORE awaiting exit to avoid race condition.
    // In Bun, once proc.exited resolves the ReadableStreams may already be
    // closed/drained, causing read failures and ECONNRESET on the HTTP side.
    const [stdout, stderr, exitCode] = await Promise.race([
      Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]),
      timeoutPromise,
    ]);
    clearTimeout(timeoutId);

    const shouldReject = options.reject ?? true;
    if (shouldReject && exitCode !== 0) {
      const reason = stderr.trim() || stdout.trim();
      throw new ProcessExecutionError(
        reason || `Command failed: ${command} ${args.join(' ')}`,
        exitCode,
        stdout,
        stderr,
        `${command} ${args.join(' ')}`,
      );
    }

    return { stdout, stderr, exitCode };
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof ProcessExecutionError) throw error;
    throw error;
  }
}

/**
 * Execute a command synchronously (use sparingly, only for startup checks)
 */
export function executeSync(
  command: string,
  args: string[],
  options: ProcessOptions = {},
): { stdout: string; stderr: string; exitCode: number } {
  const result = Bun.spawnSync([command, ...args], {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : undefined,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  const exitCode = result.exitCode;

  const shouldReject = options.reject ?? true;
  if (shouldReject && exitCode !== 0) {
    const reason = stderr.trim() || stdout.trim();
    throw new ProcessExecutionError(
      reason || `Command failed: ${command} ${args.join(' ')}`,
      exitCode,
      stdout,
      stderr,
      `${command} ${args.join(' ')}`,
    );
  }

  return { stdout, stderr, exitCode };
}

/**
 * Execute command with logging for debugging
 */
export async function executeWithLogging(
  command: string,
  args: string[],
  options: ProcessOptions = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const start = Date.now();
  const argsStr = args.join(' ');
  console.log(`[exec] ${command} ${argsStr}`);

  try {
    const result = await execute(command, args, options);
    const duration = Date.now() - start;
    console.log(`[exec] done ${command} (${duration}ms)`);
    return result;
  } catch (error) {
    const duration = Date.now() - start;
    console.error(`[exec] fail ${command} (${duration}ms)`, error);
    throw error;
  }
}

/**
 * Execute a command returning ResultAsync instead of throwing
 */
export function executeResult(
  command: string,
  args: string[],
  options: ProcessOptions = {},
): ResultAsync<ProcessResult, DomainError> {
  return ResultAsync.fromPromise(execute(command, args, options), (error) => {
    if (error instanceof ProcessExecutionError) {
      return processError(error.message, error.exitCode, error.stderr);
    }
    return internal(String(error));
  });
}
