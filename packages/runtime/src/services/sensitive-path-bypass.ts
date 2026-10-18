/**
 * Sensitive-path bypass executor — performs Write/Edit/Bash/Read/NotebookEdit
 * operations directly when the user has saved an "always allow" rule for a
 * tool that touches a path the SDK considers sensitive (e.g. `~/.claude/`).
 *
 * The Claude Agent SDK applies its own hardcoded sensitive-path block AFTER
 * the PreToolUse hook returns, so we cannot honor the user's rule by simply
 * answering `permissionDecision: 'allow'` — the SDK will still deny the
 * call. Instead we execute the operation here and return text that the hook
 * surfaces as the synthetic tool_result so the model sees a successful
 * outcome.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { buildChildEnv } from '@funny/shared/lib/child-env';

import { log } from '../lib/logger.js';

interface BypassQuery {
  toolName: string;
  toolInput: unknown;
  cwd?: string;
}

interface BypassResult {
  output: string;
}

const NAMESPACE = 'sensitive-path-bypass';

export async function runSensitivePathBypass(query: BypassQuery): Promise<BypassResult | null> {
  const { toolName, toolInput, cwd } = query;
  const ti = (toolInput ?? {}) as Record<string, unknown>;

  if (toolName === 'Write') {
    const filePath = typeof ti.file_path === 'string' ? ti.file_path : null;
    const content = typeof ti.content === 'string' ? ti.content : null;
    if (!filePath || content === null) return null;
    const existed = await fileExists(filePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf8');
    log.info('sensitive bypass Write executed', {
      namespace: NAMESPACE,
      filePath,
      existed: String(existed),
      bytes: Buffer.byteLength(content, 'utf8'),
    });
    return {
      output: existed
        ? `The file ${filePath} has been updated.`
        : `File created successfully at: ${filePath}`,
    };
  }

  if (toolName === 'Edit') {
    const filePath = typeof ti.file_path === 'string' ? ti.file_path : null;
    const oldString = typeof ti.old_string === 'string' ? ti.old_string : null;
    const newString = typeof ti.new_string === 'string' ? ti.new_string : null;
    const replaceAll = ti.replace_all === true;
    if (!filePath || oldString === null || newString === null) return null;
    const original = await fs.readFile(filePath, 'utf8');
    if (!replaceAll && countOccurrences(original, oldString) > 1) {
      return {
        output: `Error: old_string is not unique in ${filePath}. Use replace_all or provide a more specific old_string.`,
      };
    }
    if (!original.includes(oldString)) {
      return { output: `Error: old_string was not found in ${filePath}.` };
    }
    const next = replaceAll
      ? original.split(oldString).join(newString)
      : original.replace(oldString, newString);
    await fs.writeFile(filePath, next, 'utf8');
    log.info('sensitive bypass Edit executed', {
      namespace: NAMESPACE,
      filePath,
      replaceAll: String(replaceAll),
    });
    return { output: `The file ${filePath} has been updated.` };
  }

  if (toolName === 'Read') {
    const filePath = typeof ti.file_path === 'string' ? ti.file_path : null;
    if (!filePath) return null;
    const data = await fs.readFile(filePath, 'utf8');
    log.info('sensitive bypass Read executed', {
      namespace: NAMESPACE,
      filePath,
      bytes: Buffer.byteLength(data, 'utf8'),
    });
    // Match the SDK's standard Read output: numbered lines.
    const numbered = data
      .split('\n')
      .map((line, i) => `${String(i + 1).padStart(6)}\t${line}`)
      .join('\n');
    return { output: numbered };
  }

  if (toolName === 'NotebookEdit') {
    // Notebook editing is non-trivial (cell-level operations) — bail out
    // and let the SDK's normal block surface a fresh permission prompt.
    return null;
  }

  if (toolName === 'Bash') {
    const command = typeof ti.command === 'string' ? ti.command : null;
    if (!command) return null;
    return await runBash(command, cwd);
  }

  return null;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) return count;
    count++;
    from = idx + needle.length;
  }
}

async function runBash(command: string, cwd: string | undefined): Promise<BypassResult> {
  return await new Promise<BypassResult>((resolve) => {
    const child = spawn('bash', ['-lc', command], {
      cwd: cwd && cwd.length > 0 ? cwd : process.cwd(),
      env: buildChildEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on('data', (b) => stdoutChunks.push(Buffer.from(b)));
    child.stderr?.on('data', (b) => stderrChunks.push(Buffer.from(b)));
    child.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      log.info('sensitive bypass Bash executed', {
        namespace: NAMESPACE,
        commandPreview: command.slice(0, 200),
        exitCode: String(code ?? -1),
        stdoutBytes: stdout.length,
        stderrBytes: stderr.length,
      });
      const trailer = code === 0 ? '' : `\n[exit code ${code}]`;
      const combined = [stdout, stderr ? `[stderr]\n${stderr}` : ''].filter(Boolean).join('\n');
      resolve({ output: (combined || '(no output)') + trailer });
    });
    child.on('error', (err) => {
      log.warn('sensitive bypass Bash spawn error', {
        namespace: NAMESPACE,
        error: (err as Error).message,
      });
      resolve({ output: `Error executing command: ${(err as Error).message}` });
    });
  });
}
