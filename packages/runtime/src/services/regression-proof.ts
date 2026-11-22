/**
 * Regression proof service: runs the changed test files against the base
 * commit (must fail) and the head commit (must pass) to prove a fix.
 *
 * The proof runs in temporary worktrees: the base phase in a detached
 * worktree at the merge-base, the head phase in the thread's own worktree
 * when it's clean at headSha, else a second temporary worktree.
 */

import { randomUUID } from 'node:crypto';

import {
  changedFilesBetween,
  copyFilesFromCommit,
  createTempWorktree,
  execute,
  gitNetwork,
  gitRead,
  mergeBase,
  removeTempWorktree,
  sweepTempWorktrees,
} from '@funny/core/git';

import { log } from '../lib/logger.js';

const ns = 'regression-proof';

export type ProofVerdict = 'pass' | 'fail' | 'skipped';

export interface ProofRule {
  globs: string[];
  command: string;
  cwd?: string;
}

export interface ProofRequest {
  headSha: string;
  defaultBranch: string;
  rules: ProofRule[];
  supportGlobs: string[];
  timeoutMs: number;
}

export interface ProofResult {
  verdict: ProofVerdict;
  finding?: string;
  files: string[];
  commands: string[];
  baseSha: string;
  outputTail: string;
}

export type ProofJobState = 'running' | 'done';

export interface ProofJob {
  id: string;
  headSha: string;
  state: ProofJobState;
  result?: ProofResult;
  controller: AbortController;
}

const DEFAULT_SUPPORT_GLOBS = [
  '**/__fixtures__/**',
  '**/fixtures/**',
  '**/__snapshots__/**',
  '**/__mocks__/**',
  '**/test-utils/**',
  '**/testing/**',
];

function matchesGlob(file: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '☆')
    .replace(/\*/g, '[^/]*')
    .replace(/☆/g, '.*');
  return new RegExp(`^${escaped}$`).test(file);
}

function matchesAnyGlob(file: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesGlob(file, p));
}

function assignFilesToRules(files: string[], rules: ProofRule[]): Map<ProofRule, string[]> {
  const assignments = new Map<ProofRule, string[]>();
  for (const rule of rules) assignments.set(rule, []);

  for (const file of files) {
    for (const rule of rules) {
      if (matchesAnyGlob(file, rule.globs)) {
        assignments.get(rule)!.push(file);
        break;
      }
    }
  }
  return assignments;
}

function shellQuote(files: string[], cwd?: string): string {
  return files
    .map((f) => {
      const relative = cwd
        ? f.replace(new RegExp(`^${cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?`), '')
        : f;
      return `'${relative.replace(/'/g, "'\\''")}'`;
    })
    .join(' ');
}

async function runCommand(
  command: string,
  cwd: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{ exitCode: number; output: string }> {
  const result = await execute('sh', ['-c', command], {
    cwd,
    signal,
    timeout: timeoutMs,
    reject: false,
    maxOutputBytes: 100_000,
  });
  return {
    exitCode: result.exitCode,
    output: (result.stdout + '\n' + result.stderr).slice(-4000),
  };
}

export async function runProof(
  projectPath: string,
  worktreePath: string | null,
  request: ProofRequest,
  signal: AbortSignal,
): Promise<ProofResult> {
  const { headSha, defaultBranch, rules, timeoutMs } = request;
  const supportGlobs =
    request.supportGlobs.length > 0 ? request.supportGlobs : DEFAULT_SUPPORT_GLOBS;

  const tempWorktrees: string[] = [];
  const cleanup = async () => {
    for (const wt of tempWorktrees) {
      await removeTempWorktree(projectPath, wt).match(
        () => {},
        () => {},
      );
    }
  };

  try {
    // Fetch to ensure we have the latest refs
    await gitNetwork(['fetch', 'origin', defaultBranch], {
      cwd: projectPath,
      reject: false,
      timeout: 60_000,
    });

    // Compute merge-base
    const baseResult = await mergeBase(projectPath, `origin/${defaultBranch}`, headSha);
    if (baseResult.isErr()) {
      return {
        verdict: 'fail',
        finding: `Could not compute merge-base: ${baseResult.error.message}`,
        files: [],
        commands: [],
        baseSha: '',
        outputTail: '',
      };
    }
    const baseSha = baseResult.value;

    // Get changed files
    const changedResult = await changedFilesBetween(projectPath, baseSha, headSha);
    if (changedResult.isErr()) {
      return {
        verdict: 'fail',
        finding: `Could not list changed files: ${changedResult.error.message}`,
        files: [],
        commands: [],
        baseSha,
        outputTail: '',
      };
    }

    // Assign files to rules
    const assignments = assignFilesToRules(changedResult.value, rules);
    const testFiles: string[] = [];
    const activeRules: Array<{ rule: ProofRule; files: string[] }> = [];
    for (const [rule, files] of assignments) {
      if (files.length > 0) {
        testFiles.push(...files);
        activeRules.push({ rule, files });
      }
    }

    if (testFiles.length === 0) {
      return {
        verdict: 'skipped',
        finding: 'No test files changed',
        files: [],
        commands: [],
        baseSha,
        outputTail: '',
      };
    }

    // Identify support files
    const supportFiles = changedResult.value.filter(
      (f) => !testFiles.includes(f) && matchesAnyGlob(f, supportGlobs),
    );

    const commands = activeRules.map(({ rule, files }) => {
      const quoted = shellQuote(files, rule.cwd);
      return rule.command.replace('{{files}}', quoted);
    });

    // --- Base phase: create temp worktree at baseSha ---
    const baseWtResult = await createTempWorktree(projectPath, baseSha, 'base');
    if (baseWtResult.isErr()) {
      return {
        verdict: 'fail',
        finding: `Setup failed: ${baseWtResult.error.message}`,
        files: testFiles,
        commands,
        baseSha,
        outputTail: '',
      };
    }
    const baseWt = baseWtResult.value;
    tempWorktrees.push(baseWt);

    // Copy test files and support files from headSha into the base worktree
    const filesToCopy = [...testFiles, ...supportFiles];
    const copyResult = await copyFilesFromCommit(projectPath, baseWt, headSha, filesToCopy);
    if (copyResult.isErr()) {
      return {
        verdict: 'fail',
        finding: `Copy failed: ${copyResult.error.message}`,
        files: testFiles,
        commands,
        baseSha,
        outputTail: '',
      };
    }

    // Run setup commands if any (e.g., bun install) in the base worktree
    // For now we just run the proof commands directly

    // Run commands on the base — at least one must fail
    let basePassed = true;
    let baseOutput = '';
    for (const { rule, files } of activeRules) {
      if (signal.aborted)
        return {
          verdict: 'fail',
          finding: 'Aborted',
          files: testFiles,
          commands,
          baseSha,
          outputTail: '',
        };
      const quoted = shellQuote(files, rule.cwd);
      const cmd = rule.command.replace('{{files}}', quoted);
      const cwd = rule.cwd ? `${baseWt}/${rule.cwd}` : baseWt;
      const result = await runCommand(cmd, cwd, signal, timeoutMs);
      baseOutput += result.output;
      if (result.exitCode !== 0) {
        basePassed = false;
      }
    }

    if (basePassed) {
      return {
        verdict: 'fail',
        finding: 'The tests pass on the base commit — they do not catch the bug',
        files: testFiles,
        commands,
        baseSha,
        outputTail: baseOutput.slice(-4000),
      };
    }

    // --- Head phase: use the thread's worktree or create a temp one ---
    let headWt = worktreePath;
    let headWtIsTemp = false;

    if (headWt) {
      const headCheck = await gitRead(['rev-parse', 'HEAD'], { cwd: headWt, reject: false });
      const isClean = headCheck.exitCode === 0 && headCheck.stdout.trim() === headSha;
      if (!isClean) headWt = null;
    }

    if (!headWt) {
      const headWtResult = await createTempWorktree(projectPath, headSha, 'head');
      if (headWtResult.isErr()) {
        return {
          verdict: 'fail',
          finding: `Head setup failed: ${headWtResult.error.message}`,
          files: testFiles,
          commands,
          baseSha,
          outputTail: baseOutput.slice(-4000),
        };
      }
      headWt = headWtResult.value;
      tempWorktrees.push(headWt);
      headWtIsTemp = true;
    }

    // Run commands on the head — every command must pass
    let headOutput = '';
    for (const { rule, files } of activeRules) {
      if (signal.aborted)
        return {
          verdict: 'fail',
          finding: 'Aborted',
          files: testFiles,
          commands,
          baseSha,
          outputTail: '',
        };
      const quoted = shellQuote(files, rule.cwd);
      const cmd = rule.command.replace('{{files}}', quoted);
      const cwd = rule.cwd ? `${headWt}/${rule.cwd}` : headWt;
      const result = await runCommand(cmd, cwd, signal, timeoutMs);
      headOutput += result.output;
      if (result.exitCode !== 0) {
        return {
          verdict: 'fail',
          finding: `Tests fail on the head commit`,
          files: testFiles,
          commands,
          baseSha,
          outputTail: headOutput.slice(-4000),
        };
      }
    }

    return {
      verdict: 'pass',
      files: testFiles,
      commands,
      baseSha,
      outputTail: headOutput.slice(-2000),
    };
  } finally {
    await cleanup();
  }
}

// ── Job registry ──────────────────────────────────────────────

const jobs = new Map<string, ProofJob>();

function jobKey(threadId: string): string {
  return threadId;
}

export function startProofJob(
  threadId: string,
  projectPath: string,
  worktreePath: string | null,
  request: ProofRequest,
): ProofJob {
  const key = jobKey(threadId);
  const existing = jobs.get(key);

  if (existing) {
    if (existing.headSha === request.headSha) {
      return existing;
    }
    existing.controller.abort();
    jobs.delete(key);
  }

  const id = randomUUID();
  const controller = new AbortController();
  const job: ProofJob = {
    id,
    headSha: request.headSha,
    state: 'running',
    controller,
  };
  jobs.set(key, job);

  runProof(projectPath, worktreePath, request, controller.signal)
    .then((result) => {
      job.result = result;
      job.state = 'done';
      log.info('Regression proof completed', { namespace: ns, threadId, verdict: result.verdict });
    })
    .catch((err) => {
      job.result = {
        verdict: 'fail',
        finding: `Proof error: ${err instanceof Error ? err.message : String(err)}`,
        files: [],
        commands: [],
        baseSha: '',
        outputTail: '',
      };
      job.state = 'done';
      log.error('Regression proof failed', { namespace: ns, threadId, error: String(err) });
    });

  return job;
}

export function getProofJob(threadId: string, proofId: string): ProofJob | null {
  const job = jobs.get(jobKey(threadId));
  if (!job || job.id !== proofId) return null;
  return job;
}

export async function sweepProofWorktrees(projectPath: string): Promise<number> {
  const result = await sweepTempWorktrees(projectPath);
  return result.match(
    (n) => n,
    () => 0,
  );
}
