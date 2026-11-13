import { spawn } from 'node:child_process';

import { killProcessTree } from '@funny/core/agents';
import { buildChildEnv } from '@funny/shared/lib/child-env';

const SHELL_ESCAPE_TIMEOUT_MS = 120_000;
const SHELL_ESCAPE_MAX_BUFFER_BYTES = 1024 * 1024 * 8;
const SHELL_ESCAPE_MAX_OUTPUT_CHARS = 60_000;

export interface ShellEscapeResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  outputTruncated: boolean;
  errorMessage?: string;
}

export function extractShellEscapeCommand(content: string): string | null {
  const trimmedStart = content.trimStart();
  if (!trimmedStart.startsWith('!')) return null;
  return trimmedStart.slice(1).trim();
}

/**
 * Run a `!cmd` shell escape in `cwd`.
 *
 * The shell leads its own process group (`detached` on POSIX), so a timeout
 * kills everything the command started, not just the shell (#190). It gets
 * {@link buildChildEnv}, never the runner's own secrets.
 */
export function executeShellEscape(
  command: string,
  cwd: string,
  options: { timeoutMs?: number } = {},
): Promise<ShellEscapeResult> {
  const timeoutMs = options.timeoutMs ?? SHELL_ESCAPE_TIMEOUT_MS;
  const shell =
    process.env.SHELL || (process.platform === 'win32' ? process.env.ComSpec : undefined);

  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    let overflowed = false;
    let spawnError: Error | undefined;

    const child = spawn(command, {
      cwd,
      shell: shell ?? true,
      env: buildChildEnv(),
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > SHELL_ESCAPE_MAX_BUFFER_BYTES) {
        if (!overflowed) {
          overflowed = true;
          killProcessTree(child);
        }
        return;
      }
      into.push(chunk);
    };
    child.stdout?.on('data', collect(stdout));
    child.stderr?.on('data', collect(stderr));

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);

    child.on('error', (err) => {
      spawnError = err;
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const errorMessage =
        spawnError?.message ??
        (overflowed
          ? 'stdout maxBuffer length exceeded'
          : code === 0 && !timedOut
            ? undefined
            : `Command failed: ${command}`);
      resolve(
        normalizeShellResult({
          command,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          exitCode: spawnError ? null : code,
          signal: signal ?? null,
          timedOut,
          errorMessage,
        }),
      );
    });
  });
}

export function formatShellEscapeOutput(result: ShellEscapeResult): string {
  const output = [result.stdout, result.stderr]
    .filter(Boolean)
    .join(result.stdout && result.stderr ? '\n' : '');
  const lines: string[] = [];

  if (output) lines.push(output);
  else lines.push('(no output)');

  if (result.timedOut) {
    lines.push(`Command timed out after ${Math.round(SHELL_ESCAPE_TIMEOUT_MS / 1000)}s.`);
  } else if (result.exitCode && result.exitCode !== 0) {
    lines.push(`Command exited with code ${result.exitCode}.`);
  } else if (result.signal) {
    lines.push(`Command terminated by ${result.signal}.`);
  } else if (result.exitCode === null && result.errorMessage && !output) {
    lines.push(result.errorMessage);
  }

  if (result.outputTruncated) {
    lines.push(`Output truncated to ${SHELL_ESCAPE_MAX_OUTPUT_CHARS} characters.`);
  }

  return lines.join('\n');
}

function normalizeShellResult(args: {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
  errorMessage?: string;
}): ShellEscapeResult {
  const combined = truncateCombinedOutput(args.stdout, args.stderr);
  return {
    command: args.command,
    stdout: combined.stdout,
    stderr: combined.stderr,
    exitCode: args.exitCode,
    signal: args.signal ?? null,
    timedOut: args.timedOut ?? false,
    outputTruncated: combined.truncated,
    errorMessage: args.errorMessage,
  };
}

function truncateCombinedOutput(
  stdout: string,
  stderr: string,
): { stdout: string; stderr: string; truncated: boolean } {
  let remaining = SHELL_ESCAPE_MAX_OUTPUT_CHARS;
  const nextStdout = stdout.slice(0, remaining);
  remaining -= nextStdout.length;
  const nextStderr = stderr.slice(0, Math.max(remaining, 0));
  return {
    stdout: nextStdout,
    stderr: nextStderr,
    truncated: nextStdout.length < stdout.length || nextStderr.length < stderr.length,
  };
}
