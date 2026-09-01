import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter } from 'node:path';

import { processError, internal, type DomainError } from '@funny/shared/errors';
import { ResultAsync } from 'neverthrow';
import pLimit from 'p-limit';

/** Whether we're running under Bun (vs Node/vitest) */
const hasBun = typeof globalThis.Bun !== 'undefined';

const POSIX_SYSTEM_PATHS = ['/usr/local/bin', '/usr/bin', '/bin'];

/**
 * Service managers and desktop launchers can provide a reduced PATH that omits
 * the system Git installation. Keep the inherited environment, but make the
 * standard POSIX command locations available to every Git subprocess.
 */
export function buildProcessEnv(
  overrides?: Record<string, string>,
  inherited: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string | undefined> {
  const env = { ...inherited, ...overrides };
  if (platform !== 'win32') {
    const paths = (env.PATH ?? '').split(delimiter).filter(Boolean);
    for (const systemPath of POSIX_SYSTEM_PATHS) {
      if (!paths.includes(systemPath)) paths.push(systemPath);
    }
    env.PATH = paths.join(delimiter);
  }
  return env;
}

function processEnvFor(
  command: string,
  overrides?: Record<string, string>,
): Record<string, string | undefined> | undefined {
  if (command === 'git') return buildProcessEnv(overrides);
  return overrides ? { ...process.env, ...overrides } : undefined;
}

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
  /**
   * Maximum bytes to buffer for stdout+stderr combined. Process is killed and
   * the promise rejects if exceeded. Defaults to DEFAULT_MAX_OUTPUT_BYTES.
   * Set to 0 to disable the cap (use with care — large diffs can OOM).
   */
  maxOutputBytes?: number;
}

/** 50MB default — protects against huge `git diff` outputs OOMing the runner. */
export const DEFAULT_MAX_OUTPUT_BYTES = 50 * 1024 * 1024;

export class ProcessOutputTooLargeError extends Error {
  constructor(
    public command: string,
    public limit: number,
  ) {
    super(`Command output exceeded ${limit} bytes: ${command}`);
    this.name = 'ProcessOutputTooLargeError';
  }
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

// ─── Concurrency pools ──────────────────────────────────
// Read-only git commands use --no-optional-locks and don't contend for
// .git/index.lock, so they can safely run at high concurrency.
const readPool = pLimit(20);

// Mutating git commands (add, commit, push, …) take locks and must be
// limited to avoid contention and corruption.
const writePool = pLimit(4);

// Non-git commands (shell, gh CLI, etc.) — unchanged from original.
const processPool = pLimit(6);

/**
 * Execute a read-only git command with --no-optional-locks.
 * Uses a high-concurrency pool since reads don't contend for locks.
 */
export async function gitRead(
  args: string[],
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  return readPool(() => _executeRaw('git', ['--no-optional-locks', ...args], options));
}

/**
 * Execute a mutating git command through the write pool.
 */
export async function gitWrite(
  args: string[],
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  return writePool(() => _executeRaw('git', args, options));
}

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
  if (hasBun) return _executeRawBun(command, args, options);
  return _executeRawNode(command, args, options);
}

/**
 * Read a ReadableStream as text, enforcing a byte cap. Calls onOverflow (to
 * kill the process) and throws ProcessOutputTooLargeError once the cap is hit,
 * avoiding unbounded Buffer.concat for huge diffs.
 */
async function readStreamWithCap(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  onOverflow: () => void,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let out = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          onOverflow();
          throw new ProcessOutputTooLargeError('stream', maxBytes);
        }
        out += decoder.decode(value, { stream: true });
      }
    }
    out += decoder.decode();
    return out;
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
}

/** Bun-optimized path using Bun.spawn */
async function _executeRawBun(
  command: string,
  args: string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  const proc = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: processEnvFor(command, options.env),
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: options.stdin != null ? new Blob([options.stdin]) : undefined,
  });

  const timeoutMs = options.timeout ?? 30_000;
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
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
    const readCapped =
      maxBytes > 0
        ? (stream: ReadableStream<Uint8Array>) =>
            readStreamWithCap(stream, maxBytes, () => proc.kill())
        : (stream: ReadableStream<Uint8Array>) => new Response(stream).text();

    const [stdout, stderr, exitCode] = await Promise.race([
      Promise.all([
        readCapped(proc.stdout as ReadableStream<Uint8Array>),
        readCapped(proc.stderr as ReadableStream<Uint8Array>),
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

/** Node.js fallback using child_process.spawn (used by vitest) */
async function _executeRawNode(
  command: string,
  args: string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  const timeoutMs = options.timeout ?? 30_000;
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: processEnvFor(command, options.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (options.stdin != null) {
      proc.stdin.write(options.stdin);
      proc.stdin.end();
    } else {
      proc.stdin.end();
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let totalBytes = 0;
    let overflowed = false;
    const onChunk = (chunk: Buffer, chunks: Buffer[]) => {
      if (overflowed) return;
      chunks.push(chunk);
      totalBytes += chunk.byteLength;
      if (maxBytes > 0 && totalBytes > maxBytes) {
        overflowed = true;
        proc.kill();
        clearTimeout(timer);
        reject(new ProcessOutputTooLargeError(`${command} ${args.join(' ')}`, maxBytes));
      }
    };
    proc.stdout.on('data', (chunk: Buffer) => onChunk(chunk, stdoutChunks));
    proc.stderr.on('data', (chunk: Buffer) => onChunk(chunk, stderrChunks));

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command} ${args.join(' ')}`));
    }, timeoutMs);

    proc.on('close', (code) => {
      if (overflowed) return;
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString();
      const stderr = Buffer.concat(stderrChunks).toString();
      const exitCode = code ?? 1;

      const shouldReject = options.reject ?? true;
      if (shouldReject && exitCode !== 0) {
        const reason = stderr.trim() || stdout.trim();
        reject(
          new ProcessExecutionError(
            reason || `Command failed: ${command} ${args.join(' ')}`,
            exitCode,
            stdout,
            stderr,
            `${command} ${args.join(' ')}`,
          ),
        );
        return;
      }

      resolve({ stdout, stderr, exitCode });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Execute a command synchronously (use sparingly, only for startup checks)
 */
export function executeSync(
  command: string,
  args: string[],
  options: ProcessOptions = {},
): { stdout: string; stderr: string; exitCode: number } {
  let stdout: string;
  let stderr: string;
  let exitCode: number;

  if (hasBun) {
    const result = Bun.spawnSync([command, ...args], {
      cwd: options.cwd,
      env: processEnvFor(command, options.env),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    stdout = result.stdout.toString();
    stderr = result.stderr.toString();
    exitCode = result.exitCode;
  } else {
    const result = spawnSync(command, args, {
      cwd: options.cwd,
      env: processEnvFor(command, options.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    stdout = result.stdout?.toString() ?? '';
    stderr = result.stderr?.toString() ?? '';
    exitCode = result.status ?? 1;
  }

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
  console.debug(`[exec] ${command} ${argsStr}`);

  try {
    const result = await execute(command, args, options);
    const duration = Date.now() - start;
    console.debug(`[exec] done ${command} (${duration}ms)`);
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
