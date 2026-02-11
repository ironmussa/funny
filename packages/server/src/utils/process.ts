import { ResultAsync } from 'neverthrow';
import { processError, internal, type DomainError } from '@a-parallel/shared/errors';

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ProcessOptions {
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
  reject?: boolean; // false = don't throw on non-zero exit
  stdin?: string; // data to write to stdin
}

export class ProcessExecutionError extends Error {
  constructor(
    message: string,
    public exitCode: number,
    public stdout: string,
    public stderr: string,
    public command: string
  ) {
    super(message);
    this.name = 'ProcessExecutionError';
  }
}

/**
 * Execute a command asynchronously with proper error handling
 */
export async function execute(
  command: string,
  args: string[],
  options: ProcessOptions = {}
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
      reject(
        new Error(
          `Command timed out after ${timeoutMs}ms: ${command} ${args.join(' ')}`
        )
      );
    }, timeoutMs);
  });

  try {
    const exitCode = await Promise.race([proc.exited, timeoutPromise]);
    clearTimeout(timeoutId);

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    const shouldReject = options.reject ?? true;
    if (shouldReject && exitCode !== 0) {
      const reason = stderr.trim() || stdout.trim();
      throw new ProcessExecutionError(
        reason || `Command failed: ${command} ${args.join(' ')}`,
        exitCode,
        stdout,
        stderr,
        `${command} ${args.join(' ')}`
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
  options: ProcessOptions = {}
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
      `${command} ${args.join(' ')}`
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
  options: ProcessOptions = {}
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
  options: ProcessOptions = {}
): ResultAsync<ProcessResult, DomainError> {
  return ResultAsync.fromPromise(
    execute(command, args, options),
    (error) => {
      if (error instanceof ProcessExecutionError) {
        return processError(error.message, error.exitCode, error.stderr);
      }
      return internal(String(error));
    }
  );
}
