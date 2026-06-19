import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

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

export async function executeShellEscape(command: string, cwd: string): Promise<ShellEscapeResult> {
  const shell =
    process.env.SHELL || (process.platform === 'win32' ? process.env.ComSpec : undefined);

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      shell,
      timeout: SHELL_ESCAPE_TIMEOUT_MS,
      maxBuffer: SHELL_ESCAPE_MAX_BUFFER_BYTES,
      windowsHide: true,
    });
    return normalizeShellResult({ command, stdout, stderr, exitCode: 0 });
  } catch (err) {
    const e = err as Error & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      code?: number | string | null;
      signal?: NodeJS.Signals | null;
      killed?: boolean;
    };
    const exitCode = typeof e.code === 'number' ? e.code : null;
    const stdout = bufferToString(e.stdout);
    const stderr = bufferToString(e.stderr);
    return normalizeShellResult({
      command,
      stdout,
      stderr,
      exitCode,
      signal: e.signal ?? null,
      timedOut: e.killed === true && e.signal === 'SIGTERM',
      errorMessage: e.message,
    });
  }
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

function bufferToString(value: string | Buffer | undefined): string {
  if (!value) return '';
  return Buffer.isBuffer(value) ? value.toString('utf8') : value;
}
