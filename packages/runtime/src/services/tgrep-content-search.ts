import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { parseStoredJson } from '@funny/shared/json-validation';
import { z } from 'zod';

import type {
  ProjectTextFileResult,
  ProjectTextSearchOptions,
  ProjectTextSearchResult,
} from './project-search-provider.js';
import { tgrepRpc } from './tgrep-rpc.js';

const executeFile = promisify(execFile);
const serverSchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
});
const statusSchema = z.object({ indexing: z.boolean(), watcher_active: z.boolean() });
const rangeSchema = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]);
const searchSchema = z.object({
  matches: z.array(
    z.object({
      type: z.literal('match'),
      file: z
        .string()
        .min(1)
        .refine(
          (path) => !isAbsolute(path) && !path.replaceAll('\\', '/').split('/').includes('..'),
        ),
      line: z.number().int().positive(),
      content: z.string(),
      spans: z.array(rangeSchema),
    }),
  ),
});

export interface TgrepSearch {
  search(options: ProjectTextSearchOptions): Promise<ProjectTextSearchResult>;
  dispose(): void;
}

/** Owned, bounded content-search server for one resident worktree. */
export class TgrepContentSearch implements TgrepSearch {
  private readonly controller = new AbortController();
  private child?: ChildProcess;
  private exited?: Promise<void>;
  private ready?: Promise<number>;
  private stateDir?: string;

  constructor(
    private readonly cwd: string,
    private readonly binary: string,
    private readonly stateRoot: string,
  ) {}

  async search(options: ProjectTextSearchOptions): Promise<ProjectTextSearchResult> {
    this.controller.signal.throwIfAborted();
    this.ready ??= this.start().catch((error: unknown) => {
      this.dispose();
      throw error;
    });
    const port = await this.ready;
    const limit = Math.max(1, Math.min(10_000, options.maxResults ?? 1_000));
    const startedAt = performance.now();
    const response = await tgrepRpc(
      port,
      'search',
      {
        pattern: options.query,
        fixed_string: !options.regex,
        case_insensitive: !(
          options.caseSensitive || options.query.toLocaleLowerCase() !== options.query
        ),
        word_boundary: Boolean(options.wholeWord),
        glob: [
          ...splitGlobs(options.include),
          ...splitGlobs(options.exclude).map((glob) => (glob.startsWith('!') ? glob : `!${glob}`)),
        ],
        max_count: limit + 1,
        detail: true,
        positions: true,
      },
      this.controller.signal,
    );
    const parsed = searchSchema.safeParse(response);
    if (!parsed.success) throw new Error('search-protocol');
    const files = new Map<string, ProjectTextFileResult>();
    for (const row of parsed.data.matches.slice(0, limit)) {
      const byteLength = Buffer.byteLength(row.content);
      if (row.spans.some(([start, end]) => start > end || end > byteLength)) {
        throw new Error('range-protocol');
      }
      const path = row.file.replaceAll('\\', '/').replace(/^\.\//, '');
      const file = files.get(path) ?? { path, matches: [] };
      file.matches.push({
        line: row.line,
        text: row.content.replace(/\r?\n$/, ''),
        ranges: row.spans.map(([start, end]) => ({ start, end })),
      });
      files.set(path, file);
    }
    return {
      files: [...files.values()],
      totalMatches: Math.min(parsed.data.matches.length, limit),
      truncated: parsed.data.matches.length > limit,
      durationMs: performance.now() - startedAt,
    };
  }

  dispose(): void {
    this.controller.abort();
    this.child?.kill('SIGKILL');
    void this.cleanup();
  }

  private async cleanup(): Promise<void> {
    await this.exited;
    if (this.stateDir)
      await rm(this.stateDir, { recursive: true, force: true }).catch(() => undefined);
  }

  private async start(): Promise<number> {
    if (!isAbsolute(this.binary)) throw new Error('binary-path');
    const signal = this.controller.signal;
    const version = await executeFile(this.binary, ['--version'], {
      timeout: 5_000,
      maxBuffer: 1024,
      signal,
    });
    if (version.stdout.trim() !== 'tgrep 1.0.5') throw new Error('binary-version');
    await mkdir(this.stateRoot, { recursive: true });
    this.stateDir = await mkdtemp(join(this.stateRoot, 'tgrep-'));
    signal.throwIfAborted();
    const child = spawn(this.binary, ['serve', this.cwd, '--index-path', this.stateDir], {
      cwd: this.cwd,
      stdio: 'ignore',
      windowsHide: true,
    });
    this.child = child;
    let stopped = false;
    this.exited = new Promise((resolve) => {
      child.once('error', () => {
        stopped = true;
        resolve();
      });
      child.once('exit', () => {
        stopped = true;
        resolve();
      });
    });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      if (stopped) throw new Error('process-exit');
      const raw = await readFile(join(this.stateDir, 'serve.json'), 'utf8').catch(() => null);
      if (raw !== null) {
        const info = parseStoredJson(serverSchema, raw);
        if (info.ok && info.value.pid === child.pid) {
          const response = await tgrepRpc(info.value.port, 'status', {}, signal);
          const status = statusSchema.safeParse(response);
          if (!status.success) throw new Error('status-protocol');
          if (!status.data.indexing && status.data.watcher_active) return info.value.port;
        }
      }
      await delay(25, undefined, { signal });
    }
    throw new Error('startup-timeout');
  }
}

function splitGlobs(value?: string): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}
