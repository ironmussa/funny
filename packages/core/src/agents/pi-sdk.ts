import { randomUUID } from 'crypto';
import { existsSync, readFileSync, statSync } from 'fs';
import { isAbsolute, join, resolve } from 'path';

import { parseStoredJson } from '@funny/shared/json-validation';
import { z } from 'zod';

import { toACPImageBlocks } from './acp-image.js';
import { BaseAgentProcess } from './base-process.js';
import { createPiSessionManager } from './pi-sdk-session.js';
import type { CLIMessage } from './types.js';

const PI_BUILTIN_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];
const CODEX_HARNESS_TOOLS = [
  'shell',
  'shell_command',
  'apply_patch',
  'update_plan',
  'view_image',
  'exec_command',
  'write_stdin',
  'current_time',
  'sleep',
];
const PI_DEFAULT_TOOL_ALLOWLIST = [
  ...PI_BUILTIN_TOOLS,
  ...CODEX_HARNESS_TOOLS,
  'web_search',
  'web_fetch',
  'subagent',
  'mcp',
];
const FUNNY_TOOL_TO_PI_TOOLS: Record<string, string[]> = {
  Bash: ['bash', 'shell', 'shell_command', 'exec_command', 'write_stdin'],
  Read: ['read', 'view_image'],
  Edit: ['edit', 'apply_patch'],
  Write: ['write', 'apply_patch'],
  Glob: ['find', 'ls'],
  Grep: ['grep'],
  WebSearch: ['web_search'],
  WebFetch: ['web_fetch'],
  Task: ['subagent'],
  TodoWrite: ['update_plan'],
};
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const PI_GPT_56_MODELS = [
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', inputCost: 5, outputCost: 30 },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', inputCost: 2.5, outputCost: 15 },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', inputCost: 1, outputCost: 6 },
] as const;
const PI_GPT_56_ALIAS = 'gpt-5.6';
// Pi exposes direct API keys as `openai` and ChatGPT Plus/Pro credentials as
// `openai-codex`. The latter is the provider behind Pi's built-in GPT-5.x
// Codex catalog, so preserve whichever authenticated transport Pi advertises.
const PI_OPENAI_PROVIDERS = new Set(['openai', 'openai-codex']);
const PI_GPT_56_CONTEXT_WINDOW = 1_050_000;
const PI_GPT_56_THINKING_LEVEL_MAP = {
  off: 'none',
  minimal: null,
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'max',
};
const PI_EXTENSION_PACKAGE_SCHEMA = z
  .object({
    pi: z
      .object({
        extensions: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .passthrough();

type PiSdk = typeof import('@earendil-works/pi-coding-agent');
type AgentSession = Awaited<ReturnType<PiSdk['createAgentSession']>>['session'];
type ModelRegistry = ReturnType<PiSdk['ModelRegistry']['create']>;

export class PiSDKProcess extends BaseAgentProcess {
  private session: AgentSession | null = null;
  private unsubscribe: (() => void) | null = null;
  private startTime = 0;
  private numTurns = 0;
  private totalCost = 0;
  private assistantMessageId = randomUUID();
  private accumulatedText = '';
  private pendingThought: { id: string; text: string } | null = null;
  private seenToolCalls = new Set<string>();

  async sendPrompt(prompt: string, images?: unknown[]): Promise<void> {
    return this.enqueuePrompt(prompt, images);
  }

  async steerPrompt(prompt: string, images?: unknown[]): Promise<void> {
    if (!this.session) return this.enqueuePrompt(prompt, images);
    await this.session.steer(prompt, toPiImages(images));
  }

  async kill(): Promise<void> {
    await super.kill();
    await this.session?.abort();
  }

  protected async runProcess(): Promise<void> {
    this.startTime = Date.now();
    try {
      let sdk: PiSdk;
      try {
        sdk = await import('@earendil-works/pi-coding-agent');
      } catch {
        throw new Error(
          'Pi SDK not installed. Run: bun add --cwd packages/core @earendil-works/pi-coding-agent',
        );
      }

      const agentDir = sdk.getAgentDir();
      const authStorage = sdk.AuthStorage.create();
      const modelRegistry = sdk.ModelRegistry.create(authStorage);
      const settingsManager = sdk.SettingsManager.create(this.options.cwd, agentDir);
      const sessionManager = await createPiSessionManager(this.options.cwd, this.options.sessionId);
      const model = resolveRequestedModel(modelRegistry, this.options.model);
      const thinkingLevel = normalizeThinkingLevel(this.options.effort);
      const resourceLoader = await createResourceLoader(
        sdk,
        this.options.cwd,
        agentDir,
        settingsManager,
      );

      const { session } = await sdk.createAgentSession({
        cwd: this.options.cwd,
        agentDir,
        authStorage,
        modelRegistry,
        settingsManager,
        sessionManager,
        ...(resourceLoader ? { resourceLoader } : {}),
        ...(model ? { model } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        tools: resolvePiTools(this.options.allowedTools, this.options.disallowedTools),
      });

      this.session = session;
      this.unsubscribe = session.subscribe((event) => this.handleSessionEvent(event));
      this.emitInit(
        session.sessionId,
        normalizePiToolNames(session.getActiveToolNames?.() ?? PI_BUILTIN_TOOLS),
        formatModel(session.model, this.options.model),
        this.options.cwd,
      );

      await this.enqueuePrompt(this.options.prompt, this.options.images);
      await this.awaitShutdown();
    } finally {
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.session?.dispose();
      this.session = null;
      if (!this._exited) this.finalize();
    }
  }

  protected async runOnePrompt(prompt: string, images?: unknown[]): Promise<void> {
    if (!this.session) throw new Error('Pi SDK session is not initialized');
    this.resetTurnState();
    const turnStart = Date.now();
    try {
      await this.session.prompt(prompt, { images: toPiImages(images) });
      this.flushPendingThought();
      this.emitResult({
        sessionId: this.session.sessionId,
        subtype: 'success',
        startTime: turnStart,
        numTurns: Math.max(this.numTurns, 1),
        totalCost: this.totalCost,
        result: this.accumulatedText || undefined,
      });
    } catch (err) {
      if (this.isAborted) return;
      const errorMessage = this.extractErrorMessage(err);
      this.emitErrorToolCall(errorMessage);
      this.emitResult({
        sessionId: this.session.sessionId,
        subtype: 'error_during_execution',
        startTime: turnStart,
        numTurns: Math.max(this.numTurns, 1),
        totalCost: this.totalCost,
        result: errorMessage,
        errors: [errorMessage],
      });
    }
  }

  private handleSessionEvent(event: unknown): void {
    if (!event || typeof event !== 'object') return;
    const e = event as Record<string, any>;
    switch (e.type) {
      case 'message_update':
        this.handleMessageUpdate(e.assistantMessageEvent);
        break;
      case 'tool_execution_start':
        this.emitToolUse(e.toolCallId, e.toolName, e.args);
        break;
      case 'tool_execution_update':
        this.emitToolUse(e.toolCallId, e.toolName, e.args);
        break;
      case 'tool_execution_end':
        this.emitToolResult(e.toolCallId, e.toolName, e.result, e.isError === true);
        break;
      case 'turn_end':
        this.numTurns++;
        this.captureUsage(e.message);
        this.flushPendingThought();
        this.assistantMessageId = randomUUID();
        this.accumulatedText = '';
        break;
      case 'agent_end':
        this.captureMessagesUsage(e.messages);
        break;
      case 'compaction_end':
        if (e.result) {
          this.emit('message', {
            type: 'compact_boundary',
            trigger: e.reason === 'manual' ? 'manual' : 'auto',
            preTokens: e.result.tokensBefore ?? 0,
            postTokens: e.result.tokensAfter ?? 0,
            sessionId: this.session?.sessionId ?? '',
          } as CLIMessage);
        }
        break;
      default:
        break;
    }
  }

  private handleMessageUpdate(event: unknown): void {
    if (!event || typeof event !== 'object') return;
    const e = event as Record<string, any>;
    if (e.type === 'text_delta' && typeof e.delta === 'string' && e.delta) {
      this.flushPendingThought();
      this.accumulatedText += e.delta;
      this.emit('message', {
        type: 'assistant',
        message: {
          id: this.assistantMessageId,
          content: [{ type: 'text', text: this.accumulatedText }],
        },
      } as CLIMessage);
      return;
    }
    if (e.type === 'thinking_delta' && typeof e.delta === 'string' && e.delta) {
      if (!this.pendingThought) this.pendingThought = { id: randomUUID(), text: '' };
      this.pendingThought.text += e.delta;
      return;
    }
    if (e.type === 'toolcall_end' && e.toolCall) {
      this.emitToolUse(e.toolCall.id, e.toolCall.name, e.toolCall.arguments);
    }
  }

  private emitToolUse(toolCallId: unknown, toolName: unknown, input: unknown): void {
    const id = typeof toolCallId === 'string' && toolCallId ? toolCallId : randomUUID();
    if (this.seenToolCalls.has(id)) return;
    const normalized = normalizePiToolCall(toolName, input);
    this.flushPendingThought();
    this.seenToolCalls.add(id);
    this.emit('message', {
      type: 'assistant',
      message: {
        id: randomUUID(),
        content: [
          {
            type: 'tool_use',
            id,
            name: normalized.name,
            input: normalized.input,
          },
        ],
      },
    } as CLIMessage);
  }

  private emitToolResult(
    toolCallId: unknown,
    toolName: unknown,
    result: unknown,
    isError: boolean,
  ): void {
    const id = typeof toolCallId === 'string' && toolCallId ? toolCallId : randomUUID();
    this.emitToolUse(id, toolName, {});
    this.emit('message', {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: id,
            content: formatToolResultContent(result, isError),
          },
        ],
      },
    } as CLIMessage);
  }

  private flushPendingThought(): void {
    if (!this.pendingThought?.text.trim()) {
      this.pendingThought = null;
      return;
    }
    const { id, text } = this.pendingThought;
    this.pendingThought = null;
    this.emit('message', {
      type: 'assistant',
      message: {
        id: randomUUID(),
        content: [{ type: 'tool_use', id, name: 'Think', input: { content: text } }],
      },
    } as CLIMessage);
    this.emit('message', {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: id, content: text }],
      },
    } as CLIMessage);
  }

  private resetTurnState(): void {
    this.numTurns = 0;
    this.totalCost = 0;
    this.assistantMessageId = randomUUID();
    this.accumulatedText = '';
    this.pendingThought = null;
    this.seenToolCalls.clear();
  }

  private captureMessagesUsage(messages: unknown): void {
    if (!Array.isArray(messages)) return;
    for (const msg of messages) this.captureUsage(msg);
  }

  private captureUsage(message: unknown): void {
    if (!message || typeof message !== 'object') return;
    const usage = (message as Record<string, any>).usage;
    if (!usage || typeof usage !== 'object') return;
    const input = Number(usage.input ?? 0);
    const output = Number(usage.output ?? 0);
    const cacheRead = Number(usage.cacheRead ?? 0);
    const cacheWrite = Number(usage.cacheWrite ?? 0);
    const cost = Number(usage.cost?.total ?? 0);
    this.totalCost += Number.isFinite(cost) ? cost : 0;
    if (input > 0 || output > 0 || cacheRead > 0 || cacheWrite > 0) {
      this.emitContextUsageMessage({
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
      });
    }
  }
}

function normalizePiToolNames(names: string[]): string[] {
  const normalized = new Set<string>();
  for (const name of names) {
    normalized.add(normalizePiToolName(name));
  }
  return [...normalized];
}

function normalizePiToolCall(toolName: unknown, input: unknown): { name: string; input: unknown } {
  const name = normalizePiToolName(toolName);
  switch (name) {
    case 'Bash':
      return { name, input: normalizeCommandInput(input) };
    case 'Read':
    case 'Write':
    case 'Edit':
      return { name, input: normalizeFileInput(input) };
    case 'Grep':
      return { name, input: normalizeSearchInput(input) };
    default:
      return { name, input: input ?? {} };
  }
}

function normalizePiToolName(toolName: unknown): string {
  if (typeof toolName !== 'string' || !toolName) return 'Tool';
  switch (toolName) {
    case 'bash':
    case 'shell':
    case 'shell_command':
    case 'exec_command':
      return 'Bash';
    case 'read':
      return 'Read';
    case 'write':
      return 'Write';
    case 'edit':
      return 'Edit';
    case 'grep':
      return 'Grep';
    case 'find':
    case 'ls':
      return 'Glob';
    case 'web_search':
      return 'WebSearch';
    case 'web_fetch':
      return 'WebFetch';
    default:
      return toolName;
  }
}

function normalizeCommandInput(input: unknown): unknown {
  if (typeof input === 'string') return { command: input };
  const record = cloneRecord(input);
  if (!record) return input ?? {};

  const command = firstString(record.command, record.cmd);
  if (command) record.command = command;
  const workdir = firstString(record.workdir, record.cwd);
  if (workdir) record.workdir = workdir;
  return record;
}

function normalizeFileInput(input: unknown): unknown {
  if (typeof input === 'string') return { file_path: input };
  const record = cloneRecord(input);
  if (!record) return input ?? {};

  const filePath = firstString(record.file_path, record.path, record.file, record.filePath);
  if (filePath) record.file_path = filePath;
  return record;
}

function normalizeSearchInput(input: unknown): unknown {
  const record = cloneRecord(input);
  if (!record) return input ?? {};

  const pattern = firstString(record.pattern, record.query);
  if (pattern) record.pattern = pattern;
  return record;
}

function cloneRecord(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  return { ...(input as Record<string, unknown>) };
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

export async function discoverPiModels(): Promise<
  | { ok: true; models: { modelId: string; name: string }[]; currentModelId: string | null }
  | {
      ok: false;
      reason: 'sdk_missing' | 'auth_required' | 'agent_error' | 'no_models';
      message?: string;
    }
> {
  let sdk: PiSdk;
  try {
    sdk = await import('@earendil-works/pi-coding-agent');
  } catch {
    return { ok: false, reason: 'sdk_missing', message: 'Pi SDK is not installed' };
  }

  try {
    const authStorage = sdk.AuthStorage.create();
    const registry = sdk.ModelRegistry.create(authStorage);
    const available = registry.getAvailable();
    if (available.length === 0) {
      return {
        ok: false,
        reason: 'auth_required',
        message: 'Pi returned no available models. Configure API keys or OAuth in Pi.',
      };
    }
    const models = available.map((m: any) => ({
      modelId: `${m.provider}/${m.id}`,
      name: m.name ?? `${m.provider}/${m.id}`,
    }));
    addPiGpt56Models(models, available);

    return {
      ok: true,
      models,
      currentModelId: null,
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'agent_error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export function resolveRequestedModel(
  modelRegistry: ModelRegistry,
  requested?: string,
): any | undefined {
  if (!requested || requested === 'default') return undefined;
  const [provider, ...rest] = requested.includes('/') ? requested.split('/') : [];
  if (provider && rest.length > 0) {
    const found = modelRegistry.find(provider, rest.join('/'));
    if (found) return found;

    if (PI_OPENAI_PROVIDERS.has(provider)) {
      const gpt56Id = resolvePiGpt56ModelId(rest.join('/'));
      if (gpt56Id) return createPiGpt56Model(modelRegistry, provider, gpt56Id);
    }
  }
  return modelRegistry.getAll().find((m: any) => m.id === requested);
}

function addPiGpt56Models(
  models: { modelId: string; name: string }[],
  available: Array<{ provider: string; id: string }>,
): void {
  // Use a single configured OpenAI transport so the picker does not show
  // duplicate variants when both an API key and a Codex subscription exist.
  const provider =
    available.find((model) => model.provider === 'openai-codex')?.provider ??
    available.find((model) => model.provider === 'openai')?.provider;
  if (!provider) return;

  for (const model of PI_GPT_56_MODELS) {
    const modelId = `${provider}/${model.id}`;
    if (!models.some((entry) => entry.modelId === modelId))
      models.push({ modelId, name: model.name });
  }
}

function resolvePiGpt56ModelId(requested: string): string | undefined {
  if (requested === PI_GPT_56_ALIAS) return 'gpt-5.6-sol';
  return PI_GPT_56_MODELS.some((model) => model.id === requested) ? requested : undefined;
}

function createPiGpt56Model(
  modelRegistry: ModelRegistry,
  provider: string,
  id: string,
): any | undefined {
  // Pi 0.80.3 predates GPT-5.6. Its OpenAI Responses model is otherwise a
  // compatible template: retain its provider/auth/transport configuration and
  // only replace the documented GPT-5.6 model metadata.
  const template =
    modelRegistry.find(provider, 'gpt-5.5') ??
    modelRegistry.getAll().find((model: any) => model.provider === provider);
  if (!template) return undefined;

  const definition = PI_GPT_56_MODELS.find((model) => model.id === id);
  return {
    ...template,
    id,
    name: definition?.name ?? id,
    thinkingLevelMap: PI_GPT_56_THINKING_LEVEL_MAP,
    cost: {
      ...template.cost,
      input: definition?.inputCost ?? template.cost.input,
      output: definition?.outputCost ?? template.cost.output,
    },
    contextWindow: PI_GPT_56_CONTEXT_WINDOW,
    maxTokens: 128_000,
  };
}

function normalizeThinkingLevel(effort?: string): any | undefined {
  if (!effort) return undefined;
  const normalized = effort === 'max' ? 'xhigh' : effort;
  return THINKING_LEVELS.has(normalized) ? normalized : undefined;
}

export function resolvePiTools(allowed?: string[], disallowed?: string[]): string[] | undefined {
  const disallowedSet = normalizePiToolAliases(disallowed);
  if (allowed && allowed.length > 0) {
    return [...normalizePiToolAliases(allowed)].filter((tool) => !disallowedSet.has(tool));
  }
  if (!disallowed || disallowed.length === 0) return undefined;
  return PI_DEFAULT_TOOL_ALLOWLIST.filter((tool) => !disallowedSet.has(tool));
}

function normalizePiToolAliases(tools?: string[]): Set<string> {
  const normalized = new Set<string>();
  for (const tool of tools ?? []) {
    const aliases = FUNNY_TOOL_TO_PI_TOOLS[tool];
    if (aliases) {
      for (const alias of aliases) normalized.add(alias);
    } else {
      normalized.add(tool);
    }
  }
  return normalized;
}

/**
 * Extra pi extensions to load into every SDK session, given as absolute paths to
 * each extension's entry module (e.g. the pi-codex harness `index.ts`). Set via
 * `FUNNY_PI_EXTENSION_PATHS` (comma-separated). This is the in-process
 * equivalent of `pi --extension <path>`: without it, `createAgentSession` only
 * discovers project-local / globally-installed extensions, so a harness living
 * outside the thread's cwd (its tools + codex system prompt) never loads and a
 * codex-trained model emits its tool calls as plain text instead of structured
 * tool_use.
 */
export function resolvePiExtensionPaths(cwd = process.cwd()): string[] {
  const raw = process.env.FUNNY_PI_EXTENSION_PATHS;
  if (!raw) return [];
  return raw
    .split(',')
    .map((path) => path.trim())
    .filter(Boolean)
    .flatMap((path) => resolvePiExtensionPath(path, cwd));
}

function resolvePiExtensionPath(path: string, cwd: string): string[] {
  const resolved = resolveExistingPath(path, cwd);
  if (!resolved) return [path];
  if (!safeStat(resolved)?.isDirectory()) return [resolved];

  const manifestPath = join(resolved, 'package.json');
  const manifest = readJson(manifestPath) as { pi?: { extensions?: unknown } } | null;
  const extensions = manifest?.pi?.extensions;
  if (Array.isArray(extensions)) {
    const entries = extensions.filter((entry): entry is string => typeof entry === 'string');
    if (entries.length > 0) return entries.map((entry) => resolve(resolved, entry));
  }

  for (const fallback of ['index.ts', 'index.js', 'index.mjs']) {
    const candidate = join(resolved, fallback);
    if (existsSync(candidate)) return [candidate];
  }
  return [resolved];
}

function resolveExistingPath(path: string, cwd: string): string | null {
  if (isAbsolute(path)) return existsSync(path) ? path : null;

  let dir = cwd;
  while (true) {
    const candidate = resolve(dir, path);
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, '..');
    if (parent === dir) return null;
    dir = parent;
  }
}

function safeStat(path: string) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function readJson(path: string): unknown {
  try {
    const parsed = parseStoredJson(PI_EXTENSION_PACKAGE_SCHEMA, readFileSync(path, 'utf8'), path);
    return parsed.ok ? parsed.value : null;
  } catch {
    return null;
  }
}

/**
 * Build a resource loader that loads the configured pi extensions, or `undefined`
 * when none are configured (so `createAgentSession` keeps its default discovery).
 * A caller-supplied loader is NOT auto-reloaded by the SDK, so we reload it here.
 */
async function createResourceLoader(
  sdk: PiSdk,
  cwd: string,
  agentDir: string,
  settingsManager: ReturnType<PiSdk['SettingsManager']['create']>,
): Promise<InstanceType<PiSdk['DefaultResourceLoader']> | undefined> {
  const additionalExtensionPaths = resolvePiExtensionPaths(cwd);
  if (additionalExtensionPaths.length === 0) return undefined;

  const loader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths,
    // The codex harness injects AGENTS.md into its own system prompt; skip pi's
    // context-file injection to avoid double-loading it (mirrors pi-codex's
    // `--no-context-files`).
    noContextFiles: true,
  });
  await loader.reload();
  return loader;
}

function formatModel(model: any, fallback?: string): string {
  if (model?.provider && model?.id) return `${model.provider}/${model.id}`;
  return fallback ?? 'default';
}

function toPiImages(images: unknown): any[] {
  return toACPImageBlocks(images);
}

function stringifyToolResult(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (typeof result !== 'object') return String(result);
  const content = (result as Record<string, any>).content;
  if (Array.isArray(content)) {
    const text = content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block?.type === 'text' && typeof block.text === 'string') return block.text;
        if (block?.type === 'image') return '[image]';
        return '';
      })
      .filter(Boolean)
      .join('\n');
    if (text) return text;
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function formatToolResultContent(result: unknown, isError: boolean): string {
  const content = stringifyToolResult(result);
  return isError && content ? `Error: ${content}` : content;
}
