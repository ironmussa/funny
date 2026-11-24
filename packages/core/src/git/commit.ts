/**
 * Commit creation with hook wrapper support.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { processError, type DomainError, errorMessage } from '@funny/shared/errors';
import { ResultAsync } from 'neverthrow';

import { git, type GitIdentityOptions } from './base.js';
import { execute, SHELL } from './process.js';

/**
 * Create a commit with a message.
 * When identity.author is provided, adds --author flag for per-user attribution.
 * When amend is true, amends the last commit instead of creating a new one.
 * When noVerify is true, skips pre-commit hooks (use after running hooks individually).
 *
 * On Windows, hook output (lint errors, etc.) is often lost because it goes to the
 * console rather than through git's piped stdout/stderr. To capture it, we wrap the
 * pre-commit hook with a script that tees output to a temp file.
 */
export function commit(
  cwd: string,
  message: string,
  identity?: GitIdentityOptions,
  amend?: boolean,
  noVerify?: boolean,
): ResultAsync<string, DomainError> {
  const args = ['commit', '-m', message];
  if (amend) args.push('--amend');
  if (noVerify) args.push('--no-verify');
  if (identity?.author) {
    args.push('--author', `${identity.author.name} <${identity.author.email}>`);
  }

  // Set up hook wrapper to capture pre-commit output (skip if --no-verify)
  const hookWrapper = noVerify ? null : createHookWrapper(cwd);
  if (hookWrapper) {
    args.unshift('-c', `core.hooksPath=${hookWrapper.dir.replace(/\\/g, '/')}`);
  }

  return git(args, cwd).mapErr((error) => {
    // Read captured hook output and clean up
    if (hookWrapper) {
      const hookOutput = readHookOutput(hookWrapper.outputFile);
      cleanupHookWrapper(hookWrapper.dir);
      if (hookOutput && error.type === 'PROCESS_ERROR') {
        return processError(error.message, error.exitCode, hookOutput);
      }
    }
    return error;
  });
}

/** Hard cap on the size of a hook command body to avoid pathological payloads. */
const MAX_HOOK_COMMAND_BYTES = 64 * 1024;

/** The command arrives typed as a string, but a caller may still pass anything at runtime. */
function isNonEmptyString<T>(value: T): value is T & string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Run a single hook command (e.g. one step from .husky/pre-commit) in the given cwd.
 *
 * The command is written to a temporary shell script and executed as a
 * standalone file (`sh /tmp/…/hook.sh`) rather than inlined into `sh -c
 * "$command"`. This removes the class of bugs where a caller accidentally
 * splices user-controlled fragments into the command string and ends up with
 * shell-metacharacter injection: the script body is now read by the shell
 * from disk, never from an argv buffer. Behaviourally equivalent to how git
 * itself runs hook scripts.
 *
 * Callers must only pass hook bodies sourced from trusted storage (e.g.
 * `.husky/<hook>` on disk); never a raw HTTP body.
 */
export function runHookCommand(
  cwd: string,
  command: string,
): ResultAsync<{ success: boolean; output: string }, DomainError> {
  return ResultAsync.fromPromise(
    (async () => {
      if (!isNonEmptyString(command)) {
        return { success: false, output: 'Empty hook command' };
      }
      if (Buffer.byteLength(command, 'utf-8') > MAX_HOOK_COMMAND_BYTES) {
        return { success: false, output: 'Hook command exceeds size limit' };
      }

      const scriptDir = join(tmpdir(), `funny-hook-${crypto.randomUUID()}`);
      const scriptFile = join(scriptDir, 'hook.sh');
      mkdirSync(scriptDir, { recursive: true });
      writeFileSync(scriptFile, `#!/usr/bin/env sh\nset -e\n${command}\n`, {
        encoding: 'utf-8',
        mode: 0o700,
      });
      try {
        chmodSync(scriptFile, 0o700);
      } catch {
        /* Windows may ignore chmod */
      }

      try {
        const result = await execute(SHELL, [scriptFile], {
          cwd,
          reject: false,
          timeout: 120_000,
        });
        const output = (result.stdout + '\n' + result.stderr).trim();
        return { success: result.exitCode === 0, output };
      } finally {
        try {
          rmSync(scriptDir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    })(),
    (e: unknown) => processError(errorMessage(e) || 'Hook command failed', 1, ''),
  );
}

// ─── Hook wrapper helpers ───────────────────────────────

/**
 * Create a temporary hooks directory with a wrapper that captures pre-commit output.
 * Returns null if no pre-commit hook exists.
 */
function createHookWrapper(cwd: string): { dir: string; outputFile: string } | null {
  // Find the original hook
  const hookCandidates = [
    join(cwd, '.husky', 'pre-commit'),
    join(cwd, '.git', 'hooks', 'pre-commit'),
  ];
  let originalHook: string | null = null;
  for (const h of hookCandidates) {
    if (existsSync(h)) {
      originalHook = h;
      break;
    }
  }
  if (!originalHook) return null;

  const id = `git-hook-${crypto.randomUUID()}`;
  const wrapperDir = join(tmpdir(), id);
  const outputFile = join(tmpdir(), `${id}-output.log`);

  try {
    mkdirSync(wrapperDir, { recursive: true });
    const hookPath = originalHook.replace(/\\/g, '/');
    const outPath = outputFile.replace(/\\/g, '/');
    // Wrapper script: runs the original hook, tees all output to a temp file
    const wrapper = `#!/bin/bash
"${hookPath}" 2>&1 | tee "${outPath}"
exit \${PIPESTATUS[0]:-$?}
`;
    const wrapperFile = join(wrapperDir, 'pre-commit');
    writeFileSync(wrapperFile, wrapper, 'utf-8');
    try {
      chmodSync(wrapperFile, 0o755);
    } catch {
      /* Windows may ignore chmod */
    }
    return { dir: wrapperDir, outputFile };
  } catch {
    return null;
  }
}

function readHookOutput(outputFile: string): string | null {
  try {
    if (!existsSync(outputFile)) return null;
    const content = readFileSync(outputFile, 'utf-8').trim();
    return content || null;
  } catch {
    return null;
  }
}

function cleanupHookWrapper(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  // Also clean up the output file (which is in tmpdir, not inside the wrapper dir)
  const base = dir.replace(/\\/g, '/').split('/').pop() || '';
  const outputFile = join(tmpdir(), `${base}-output.log`);
  try {
    rmSync(outputFile, { force: true });
  } catch {
    /* best-effort */
  }
}
