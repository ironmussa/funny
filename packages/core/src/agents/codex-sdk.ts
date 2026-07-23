/**
 * CodexSDKProcess — Codex via the official @openai/codex-sdk.
 *
 * This replaces the Zed ACP adapter for the built-in Codex provider while
 * preserving funny's provider-agnostic IAgentProcess event contract.
 */

import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, dirname, isAbsolute, join } from 'path';
import { promisify } from 'util';

import {
  Codex,
  type Input,
  type ModelReasoningEffort,
  type Thread,
  type ThreadEvent,
  type ThreadItem,
  type ThreadOptions,
} from '@openai/codex-sdk';

import { createDebugLogger } from '../debug.js';
import { getFullContextFileDiff } from '../git/index.js';
import { BaseAgentProcess, type ResultSubtype } from './base-process.js';
import type { CLIMessage } from './types.js';

const dlog = createDebugLogger('codex-sdk');
const execFileAsync = promisify(execFile);
const MAX_CACHED_CREATED_FILE_DIFFS = 64;
const MAX_CACHED_CREATED_FILE_DIFF_BYTES = 512 * 1024;

const CODEX_TOOLS = [
  'read_file',
  'write_file',
  'apply_patch',
  'list_directory',
  'glob',
  'grep',
  'run_shell_command',
  'web_fetch',
];

export class CodexSDKProcess extends BaseAgentProcess {
  private codex: Codex | null = null;
  private thread: Thread | null = null;
  private activeTurnAbort: AbortController | null = null;
  private activeSessionId: string | null = null;
  private numTurns = 0;
  private totalCost = 0;
  private initEmitted = false;
  /** Last text published for each in-flight SDK item. */
  private agentMessageTextByItemId = new Map<string, string>();
  /**
   * The SDK reports deletions after the file has already disappeared. Retain
   * small creation patches so a later delete can still render its removed
   * content instead of an empty Edit card.
   */
  private createdFileDiffsByPath = new Map<string, string>();
  /**
   * Per-turn token that namespaces SDK item IDs. Codex numbers items
   * ordinally within a turn (`item_0`, `item_1`, …) and reuses those IDs on
   * the next turn / after a resume. The runtime preserves its CLI→DB message
   * map across turns and sessions (to dedup Claude `--resume` replays), so an
   * un-namespaced Codex ID from a later turn collides with an earlier turn's
   * DB row and overwrites it — leaving only the final reply persisted. Scoping
   * every emitted ID by this per-turn token keeps IDs stable across a single
   * item's incremental updates while making them globally unique across turns.
   */
  private turnToken = randomUUID();

  async sendPrompt(prompt: string, images?: unknown[]): Promise<void> {
    return this.enqueuePrompt(prompt, images);
  }

  async steerPrompt(prompt: string, images?: unknown[]): Promise<void> {
    this.activeTurnAbort?.abort();
    return this.enqueuePrompt(prompt, images);
  }

  async kill(): Promise<void> {
    this.activeTurnAbort?.abort();
    await super.kill();
  }

  protected async runProcess(): Promise<void> {
    const env = {
      ...process.env,
      ...this.options.env,
    } as Record<string, string>;

    this.codex = new Codex({
      codexPathOverride: process.env.CODEX_BINARY_PATH || process.env.CODEX_BIN,
      apiKey: this.options.env?.OPENAI_API_KEY,
      env,
      config: {
        show_raw_agent_reasoning: true,
      },
    });

    const requestedPermissionMode =
      this.options.originalPermissionMode ?? this.options.permissionMode;
    const sandboxOptions = resolveCodexSandboxOptions(requestedPermissionMode);
    const additionalDirectories =
      sandboxOptions.sandboxMode === 'workspace-write'
        ? await resolveCodexSandboxWritableDirectories(this.options.cwd)
        : [];
    const threadOptions: ThreadOptions = {
      model: this.options.model,
      workingDirectory: this.options.cwd,
      skipGitRepoCheck: true,
      modelReasoningEffort: normalizeEffort(this.options.effort),
      ...sandboxOptions,
      ...(additionalDirectories.length ? { additionalDirectories } : {}),
    };

    this.thread = this.options.sessionId
      ? this.codex.resumeThread(this.options.sessionId, threadOptions)
      : this.codex.startThread(threadOptions);
    this.activeSessionId = this.options.sessionId ?? null;

    dlog.info('starting Codex SDK thread', {
      model: this.options.model,
      cwd: this.options.cwd,
      hasResume: !!this.options.sessionId,
      permissionMode: requestedPermissionMode,
      sandboxMode: sandboxOptions.sandboxMode,
      networkAccessEnabled: sandboxOptions.networkAccessEnabled ?? false,
      additionalWritableDirectories: additionalDirectories.length,
      effort: this.options.effort ?? 'default',
    });

    await this.enqueuePrompt(this.options.prompt, this.options.images);
    await this.awaitShutdown();
    this.finalize();
  }

  protected async runOnePrompt(prompt: string, images?: unknown[]): Promise<void> {
    if (!this.thread) throw new Error('Codex SDK thread not initialized');

    const startTime = Date.now();
    const turnAbort = new AbortController();
    this.activeTurnAbort = turnAbort;

    // Fresh token per turn so this turn's item IDs never collide with a
    // previous turn's (Codex reuses ordinal item IDs across turns).
    this.beginTurn();

    let resultText = '';
    let subtype: ResultSubtype = 'success';
    const errors: string[] = [];
    const cleanupDirs: string[] = [];

    try {
      const input = await this.buildInput(prompt, images, cleanupDirs);
      const { events } = await this.thread.runStreamed(input, { signal: turnAbort.signal });

      for await (const event of events) {
        if (this.isAborted) break;
        const maybeText = await this.handleEvent(event);
        if (maybeText) resultText = maybeText;
        if (event.type === 'turn.failed') {
          subtype = 'error_during_execution';
          errors.push(event.error.message);
          this.emitErrorToolCall(event.error.message);
        }
      }
    } catch (err) {
      if (turnAbort.signal.aborted || this.isAborted) {
        subtype = this.isAborted ? 'success' : 'error_during_execution';
        if (!this.isAborted) errors.push('Turn cancelled');
      } else {
        subtype = 'error_during_execution';
        const message = this.extractErrorMessage(err);
        errors.push(message);
        this.emitErrorToolCall(message);
      }
    } finally {
      this.activeTurnAbort = null;
      await Promise.all(cleanupDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    }

    this.numTurns++;
    this.emitResult({
      sessionId: this.activeSessionId ?? this.thread.id ?? this.options.sessionId ?? '',
      subtype,
      startTime,
      numTurns: this.numTurns,
      totalCost: this.totalCost,
      result: resultText || undefined,
      errors: errors.length ? errors : undefined,
    });
  }

  private async handleEvent(event: ThreadEvent): Promise<string | null> {
    switch (event.type) {
      case 'thread.started':
        this.activeSessionId = event.thread_id;
        this.emitInitOnce(event.thread_id);
        return null;

      case 'turn.completed':
        // Codex reports token usage for the entire turn. A turn can contain
        // multiple model requests while it uses tools, so this aggregate can
        // exceed the model's context window. It is useful for cost/accounting,
        // but is not a snapshot of the current context window; publishing it
        // as one would make the UI's context meter show an incorrect 100%.
        //
        // The SDK currently exposes no per-request context-window snapshot,
        // so deliberately do not emit an `agent:context_usage` message here.
        return null;

      case 'item.started':
        await this.emitItemUpdate(event.item, false);
        return null;

      case 'item.updated':
        await this.emitItemUpdate(event.item, false);
        return null;

      case 'item.completed':
        return this.emitItemUpdate(event.item, true);

      case 'error':
        this.emitErrorToolCall(event.message);
        return null;

      default:
        return null;
    }
  }

  private emitInitOnce(sessionId: string): void {
    if (this.initEmitted) return;
    this.initEmitted = true;
    this.emitInit(sessionId, CODEX_TOOLS, this.options.model ?? 'codex', this.options.cwd);
  }

  /**
   * Map SDK items onto Funny's message protocol.
   *
   * The Codex SDK emits `item.started`, `item.updated`, and `item.completed`
   * for a single stable item ID. Publishing agent-message updates as they
   * arrive lets the runtime update one existing DB/client message instead of
   * inserting the whole reply only after the item completes. Tool and
   * reasoning cards remain completion-only because their UI needs a terminal
   * payload.
   */
  private async emitItemUpdate(item: ThreadItem, completed: boolean): Promise<string | null> {
    this.emitInitOnce(this.activeSessionId ?? this.thread?.id ?? this.options.sessionId ?? '');

    switch (item.type) {
      case 'agent_message':
        if (!item.text.trim()) return null;
        // The SDK repeats the final text in `item.completed`. Re-emitting that
        // unchanged payload can race with a following item in the runtime, so
        // publish only actual changes while retaining the SDK item ID.
        if (this.agentMessageTextByItemId.get(item.id) !== item.text) {
          this.agentMessageTextByItemId.set(item.id, item.text);
          this.emit('message', {
            type: 'assistant',
            hasStableMessageId: true,
            message: {
              id: this.scopedId(item.id),
              content: [{ type: 'text', text: item.text }],
            },
          } as CLIMessage);
        }
        if (completed) this.agentMessageTextByItemId.delete(item.id);
        return completed ? item.text : null;

      case 'reasoning':
        if (!completed) return null;
        this.emitToolPair('Think', { content: item.text }, item.text, item.id);
        return null;

      case 'command_execution':
        if (!completed) return null;
        this.emitToolPair(
          'Bash',
          { command: item.command },
          item.aggregated_output || `Command ${item.status}`,
          item.id,
          item.status === 'failed',
        );
        return null;

      case 'file_change':
        if (!completed) return null;
        // The SDK only supplies a path and kind. Capture the patch immediately:
        // later Git requests can be empty after another edit or a commit, which
        // otherwise leaves this historical Edit card with no content.
        this.emitToolPair(
          'Edit',
          { changes: await this.captureFileChangeDiffs(item.changes) },
          item.status,
          item.id,
          item.status === 'failed',
        );
        return null;

      case 'mcp_tool_call':
        if (!completed) return null;
        this.emitToolPair(
          `mcp__${item.server}__${item.tool}`,
          item.arguments,
          stringifyToolOutput(item.result ?? item.error ?? item.status),
          item.id,
          item.status === 'failed',
        );
        return null;

      case 'web_search':
        if (!completed) return null;
        this.emitToolPair('WebSearch', { query: item.query }, item.query, item.id);
        return null;

      case 'todo_list':
        if (!completed) return null;
        // Keep the provider-facing contract consistent with every other
        // checklist source. The SDK uses `{ text, completed }`, while the UI
        // and persisted TodoWrite cards use `{ content, status }`.
        const todos = item.items.map((todo) => ({
          content: todo.text,
          status: todo.completed ? 'completed' : 'pending',
        }));
        this.emitToolPair('TodoWrite', { todos }, stringifyToolOutput(todos), item.id);
        return null;

      case 'error':
        if (!completed) return null;
        this.emitErrorToolCall(item.message);
        return null;
    }
  }

  /**
   * Enrich the SDK's lightweight file-change event with the working-tree patch
   * while that patch still exists. Codex can change into a sibling worktree
   * during a turn, so absolute paths are resolved from their own directory
   * rather than the thread's original working directory.
   */
  private async captureFileChangeDiffs(
    changes: Array<{ path: string; kind: string }>,
  ): Promise<Record<string, { type: string; unified_diff?: string }>> {
    const captured = await Promise.all(
      changes.map(async (change) => {
        const absolutePath = isAbsolute(change.path);
        const cwd = absolutePath ? dirname(change.path) : this.options.cwd;
        const filePath = absolutePath ? basename(change.path) : change.path;
        const result = await getFullContextFileDiff(cwd, filePath, false);
        let unifiedDiff = result.isOk() && result.value.trim() ? result.value : undefined;
        if (!unifiedDiff && isFileDeletion(change.kind)) {
          const createdDiff = this.createdFileDiffsByPath.get(change.path);
          if (createdDiff) unifiedDiff = makeDeletionDiff(change.path, createdDiff);
          this.createdFileDiffsByPath.delete(change.path);
        }
        if (unifiedDiff && isFileCreation(change.kind)) {
          this.rememberCreatedFileDiff(change.path, unifiedDiff);
        }
        return [
          change.path,
          { type: change.kind, ...(unifiedDiff ? { unified_diff: unifiedDiff } : {}) },
        ] as const;
      }),
    );
    return Object.fromEntries(captured);
  }

  private rememberCreatedFileDiff(filePath: string, unifiedDiff: string): void {
    if (Buffer.byteLength(unifiedDiff, 'utf8') > MAX_CACHED_CREATED_FILE_DIFF_BYTES) return;
    this.createdFileDiffsByPath.delete(filePath);
    this.createdFileDiffsByPath.set(filePath, unifiedDiff);
    if (this.createdFileDiffsByPath.size > MAX_CACHED_CREATED_FILE_DIFFS) {
      const oldestPath = this.createdFileDiffsByPath.keys().next().value;
      if (oldestPath) this.createdFileDiffsByPath.delete(oldestPath);
    }
  }

  /** Start a fresh turn: rotate the ID namespace and drop per-item text state. */
  private beginTurn(): void {
    this.turnToken = randomUUID();
    this.agentMessageTextByItemId.clear();
  }

  /**
   * Namespace an SDK item ID by the current turn so IDs Codex reuses across
   * turns (`item_0`, `item_1`, …) stay globally unique in the runtime's
   * persistent CLI→DB message map, while remaining stable within a turn.
   */
  private scopedId(itemId: string): string {
    return `${this.turnToken}:${itemId}`;
  }

  private emitToolPair(
    name: string,
    input: unknown,
    output: string,
    itemId?: string,
    isError = false,
  ): void {
    const toolUseId = itemId ? this.scopedId(itemId) : randomUUID();
    this.emit('message', {
      type: 'assistant',
      message: {
        id: randomUUID(),
        content: [{ type: 'tool_use', id: toolUseId, name, input }],
      },
    } as CLIMessage);
    this.emit('message', {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: output,
            ...(isError ? { is_error: true } : {}),
          },
        ],
      },
    } as unknown as CLIMessage);
  }

  private async buildInput(
    prompt: string,
    images: unknown[] | undefined,
    cleanupDirs: string[],
  ): Promise<Input> {
    const localImages = await imagesToLocalFiles(images, cleanupDirs);
    if (!localImages.length) return prompt;
    return [
      { type: 'text', text: prompt },
      ...localImages.map((path) => ({ type: 'local_image' as const, path })),
    ];
  }
}

function normalizeEffort(effort: string | undefined): ModelReasoningEffort | undefined {
  if (!effort) return undefined;
  if (effort === 'max') return 'xhigh' as const;
  if (
    effort === 'minimal' ||
    effort === 'low' ||
    effort === 'medium' ||
    effort === 'high' ||
    effort === 'xhigh'
  ) {
    return effort;
  }
  return 'high' as const;
}

function isFileCreation(kind: string): boolean {
  return kind === 'add' || kind === 'create';
}

function isFileDeletion(kind: string): boolean {
  return kind === 'delete' || kind === 'remove';
}

/**
 * Reverse a creation patch into a deletion patch. This is used only when the
 * SDK announces that a temporary file was deleted after it has disappeared
 * from disk, so Git cannot produce the historical patch anymore.
 */
function makeDeletionDiff(filePath: string, creationDiff: string): string {
  let inHunk = false;

  return creationDiff
    .split('\n')
    .map((line) => {
      if (line.startsWith('diff --git ')) return `diff --git a/${filePath} b/${filePath}`;
      if (line.startsWith('new file mode '))
        return line.replace('new file mode ', 'deleted file mode ');
      if (line.startsWith('--- ')) return `--- a/${filePath}`;
      if (line.startsWith('+++ ')) return '+++ /dev/null';

      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
      if (hunk) {
        inHunk = true;
        const [, oldStart, oldCount, newStart, newCount, suffix] = hunk;
        const oldRange = newCount ? `${newStart},${newCount}` : newStart;
        const newRange = oldCount ? `${oldStart},${oldCount}` : oldStart;
        return `@@ -${oldRange} +${newRange} @@${suffix}`;
      }

      if (!inHunk) return line;
      if (line.startsWith('+')) return `-${line.slice(1)}`;
      if (line.startsWith('-')) return `+${line.slice(1)}`;
      return line;
    })
    .join('\n');
}

/**
 * Map Funny's provider-neutral permission modes to Codex's native sandbox.
 *
 * The orchestrator preserves the original Funny mode separately because its
 * generic provider resolver intentionally returns `undefined` for Codex. Use
 * that original value here rather than the resolved SDK-specific value.
 */
export function resolveCodexSandboxOptions(
  permissionMode: string | undefined,
  networkAccessEnabled = isCodexSandboxNetworkAccessEnabled(),
): Pick<ThreadOptions, 'sandboxMode' | 'approvalPolicy' | 'networkAccessEnabled'> {
  switch (permissionMode) {
    case 'plan':
      return { sandboxMode: 'read-only' as const, approvalPolicy: 'never' as const };
    case 'autoEdit':
    case 'bypassPermissions':
      return { sandboxMode: 'danger-full-access' as const, approvalPolicy: 'never' as const };
    case 'ask':
    case 'confirmEdit':
    case 'auto':
    default:
      return {
        sandboxMode: 'workspace-write' as const,
        approvalPolicy: 'on-request' as const,
        networkAccessEnabled,
      };
  }
}

function isCodexSandboxNetworkAccessEnabled(): boolean {
  const value = process.env.FUNNY_CODEX_SANDBOX_NETWORK_ACCESS?.trim().toLowerCase();
  return value === '1' || value === 'true';
}

/**
 * Linked Git worktrees keep their index and object store outside the checked
 * out directory. Codex's workspace-write sandbox otherwise makes `git add`
 * and `git commit` fail when they attempt to write that metadata.
 */
export async function resolveCodexSandboxWritableDirectories(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'],
      { cwd },
    );
    return [
      ...new Set(
        stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean),
      ),
    ];
  } catch {
    // Scratch threads and non-Git directories do not need extra writable roots.
    return [];
  }
}

async function imagesToLocalFiles(
  images: unknown[] | undefined,
  cleanupDirs: string[],
): Promise<string[]> {
  if (!Array.isArray(images) || images.length === 0) return [];
  const paths: string[] = [];
  let dir: string | null = null;
  for (const image of images) {
    const src = (image as any)?.source;
    const data = src?.data ?? (image as any)?.data;
    const mediaType = src?.media_type ?? (image as any)?.mimeType ?? (image as any)?.media_type;
    if (typeof data !== 'string' || typeof mediaType !== 'string') continue;
    dir ??= await mkdtemp(join(tmpdir(), 'funny-codex-images-'));
    const ext = extensionForMime(mediaType);
    const file = join(dir, `${randomUUID()}${ext}`);
    await writeFile(file, Buffer.from(data, 'base64'));
    paths.push(file);
  }
  if (dir) cleanupDirs.push(dir);
  return paths;
}

function extensionForMime(mime: string): string {
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/gif') return '.gif';
  return '.png';
}

function stringifyToolOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
