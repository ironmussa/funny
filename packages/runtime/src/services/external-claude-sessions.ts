import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { readdir, readlink, stat } from 'fs/promises';
import { homedir } from 'os';
import { basename, dirname, join } from 'path';

import { execute } from '@funny/core/git';
import type {
  ExternalClaudeSession,
  ExternalClaudeTranscript,
  ExternalClaudeTranscriptMessage,
  ExternalClaudeTranscriptToolCall,
  ImageAttachment,
} from '@funny/shared';
import { parseStoredJson } from '@funny/shared/json-validation';
import { DEFAULT_MODEL } from '@funny/shared/models';
import { nanoid } from 'nanoid';
import { z } from 'zod';

import { DATA_DIR } from '../lib/data-dir.js';
import { readFileLines } from './file-lines.js';
import type { RuntimeThreadInsert, RuntimeThreadRecord } from './server-interfaces.js';
import { getServices } from './service-registry.js';

const CLAUDE_PROJECTS_DIR = '.claude/projects';
const DISMISSED_SESSIONS_FILE = join(DATA_DIR, 'external-claude-dismissed.json');
const MAX_JSONL_FILES_PER_CWD = 8;
const MAX_PROJECT_SESSION_FILES = 200;
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
/** Session files whose metadata is remembered between syncs (oldest dropped first). */
const MAX_CACHED_SESSION_FILES = 2 * MAX_PROJECT_SESSION_FILES;
const IDE_OPENED_FILE_RE = /<ide_opened_file>[\s\S]*?<\/ide_opened_file>/g;
const PREVIEWABLE_ASSETS_BLOCK_RE = /\[PREVIEWABLE ASSETS\][\s\S]*?\[\/PREVIEWABLE ASSETS\]/g;
const LOCAL_COMMAND_CAVEAT_BLOCK_RE =
  /<local-command-caveat>[\s\S]*?(?:<\/local-command-caveat>|$)/g;
const CONTEXT_RECOVERY_PREFIX =
  '[SYSTEM NOTE: Your previous session cannot be resumed. Below is the conversation history to restore context.';
const RESUME_NOTE_PREFIX =
  '[SYSTEM NOTE: This is a session resume after an interruption. Your previous session was interrupted mid-execution.';
const RECOVERED_USER_MESSAGE_MARKER = 'USER (new message):';
const CLAUDE_CODE_SYNTHETIC_AUTHOR = 'Claude Code';
/** Claude Code's meta note naming the file a pasted image was saved to. */
const IMAGE_SOURCE_NOTE_RE = /^(?:\s*\[Image(?: #\d+)?: source: [^\]\n]+\]\s*)+$/;
/** Content blocks that never render as message text (images travel as attachments). */
const NON_TEXT_BLOCK_TYPES = new Set(['thinking', 'redacted_thinking', 'tool_use', 'image']);
let dismissedSessionIdsCache: Set<string> | null = null;

const dismissedSessionIdsSchema = z.array(z.string());

const imageBlockSchema = z.object({
  type: z.literal('image'),
  source: z.object({
    type: z.literal('base64'),
    media_type: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
    data: z.string(),
  }),
});

const claudeJsonlEntrySchema = z
  .object({
    type: z.string().optional(),
    sessionId: z.string().optional(),
    cwd: z.string().optional(),
    gitBranch: z.string().optional(),
    timestamp: z.string().optional(),
    lastPrompt: z.string().optional(),
    aiTitle: z.string().optional(),
    summary: z.string().optional(),
    uuid: z.string().optional(),
    isMeta: z.boolean().optional(),
    message: z
      .object({
        role: z.enum(['user', 'assistant', 'system']).optional(),
        content: z.unknown().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export interface ProcessInfo {
  pid: number;
  ppid: number;
  elapsedSeconds: number | null;
  command: string;
  args: string;
}

interface SessionMetadata {
  sessionId: string | null;
  cwd: string | null;
  gitBranch: string | null;
  lastPrompt: string | null;
  /** Title Claude Code generated for the session (`ai-title` entries). */
  aiTitle: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  hasDisplayableContent: boolean;
}

interface ClaudeProject {
  id: string;
  name: string;
  path: string;
}

export interface ExternalClaudeSessionOptions {
  psOutput?: string;
  currentPid?: number;
  homeDir?: string;
  now?: Date;
  getCwd?: (pid: number) => string | null | Promise<string | null>;
  projects?: ClaudeProject[];
}

export function parsePsOutput(output: string): ProcessInfo[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        elapsedSeconds: parseElapsed(match[3]),
        command: match[4],
        args: match[5],
      };
    })
    .filter((proc): proc is ProcessInfo => proc !== null);
}

export function isClaudeCodeProcess(proc: Pick<ProcessInfo, 'command' | 'args'>): boolean {
  const text = `${proc.command} ${proc.args}`;
  return /(^|[/\s])claude(\s|$)/i.test(text) || /@anthropic-ai[/\\]claude-code/i.test(text);
}

export async function listExternalClaudeSessions(
  options: ExternalClaudeSessionOptions = {},
): Promise<ExternalClaudeSession[]> {
  const runningSessions = await listRunningExternalClaudeSessions(options);
  if (options.projects?.length) {
    return listProjectClaudeSessions(options, runningSessions);
  }
  return runningSessions;
}

export async function syncExternalClaudeSessionThreads(
  params: {
    userId: string;
    projectId?: string | null;
  },
  options: ExternalClaudeSessionOptions = {},
): Promise<{ threadIds: string[] }> {
  const services = getServices();
  const allProjects = await services.projects.listProjects(params.userId);
  const projects = params.projectId
    ? allProjects.filter((project) => project.id === params.projectId)
    : allProjects;
  if (projects.length === 0) return { threadIds: [] };

  const sessions = await listExternalClaudeSessions({ ...options, projects });
  const threadIds: string[] = [];
  for (const session of sessions) {
    if (session.sessionId && getDismissedSessionIds().has(session.sessionId)) continue;
    const thread = await ensureExternalClaudeThreadShell({
      session,
      projects,
      userId: params.userId,
      projectId: params.projectId,
    });
    if (thread?.id) threadIds.push(thread.id);
  }

  return { threadIds };
}

export function dismissExternalClaudeSession(sessionId: string): boolean {
  if (!isSafeSessionId(sessionId)) return false;
  const dismissed = getDismissedSessionIds();
  dismissed.add(sessionId);
  saveDismissedSessionIds(dismissed);
  return true;
}

/** The thread a session is imported into: a `threads` row, found or created here. */
type ExternalSessionThread = Pick<RuntimeThreadRecord, 'id' | 'userId'> &
  Partial<RuntimeThreadInsert>;

export type ImportExternalClaudeSessionResult =
  | { ok: true; imported: boolean; thread: ExternalSessionThread }
  | { ok: false; status: number; error: string };

export async function importExternalClaudeSession(
  params: {
    sessionId: string;
    userId: string;
    projectId?: string | null;
  },
  options: { homeDir?: string } = {},
): Promise<ImportExternalClaudeSessionResult> {
  const { sessionId, userId } = params;
  if (!isSafeSessionId(sessionId)) {
    return { ok: false, status: 400, error: 'Invalid Claude Code session ID' };
  }

  const services = getServices();
  const existingBySessionId = await services.threads.getThreadBySessionId(sessionId);
  if (existingBySessionId) {
    return hydrateExternalClaudeThread({
      thread: existingBySessionId,
      sessionId,
      userId,
      homeDir: options.homeDir,
    });
  }

  const externalRequestId = `claude:${sessionId}`;
  const existingByExternalId =
    await services.threads.getThreadByExternalRequestId(externalRequestId);
  if (existingByExternalId) {
    return hydrateExternalClaudeThread({
      thread: existingByExternalId,
      sessionId,
      userId,
      homeDir: options.homeDir,
    });
  }

  const transcript = await readExternalClaudeTranscript(sessionId, options);
  if (!transcript) {
    return {
      ok: false,
      status: 404,
      error: 'External Claude Code session not found',
    };
  }

  const projects = await services.projects.listProjects(userId);
  const project =
    (params.projectId ? projects.find((candidate) => candidate.id === params.projectId) : null) ??
    matchProjectForCwd(transcript.cwd, projects);
  if (!project) {
    return {
      ok: false,
      status: 400,
      error: 'No Funny project matches this Claude Code session directory',
    };
  }

  const now = new Date().toISOString();
  const threadId = nanoid();
  const createdAt = transcript.startedAt ?? transcript.updatedAt ?? now;
  const updatedAt = transcript.updatedAt ?? createdAt;
  const title = transcript.title || transcript.projectName || project.name || 'Claude Code';

  const thread = {
    id: threadId,
    projectId: project.id,
    userId,
    title,
    mode: 'local',
    runtime: 'local',
    provider: 'claude',
    permissionMode: 'autoEdit',
    status: 'completed',
    stage: 'in_progress',
    model: DEFAULT_MODEL,
    branch: transcript.gitBranch,
    baseBranch: transcript.gitBranch,
    worktreePath: null,
    sessionId,
    source: 'ingest',
    externalRequestId,
    createdBy: 'external',
    initialPrompt: firstUserPrompt(transcript) ?? undefined,
    cost: 0,
    createdAt,
    updatedAt,
    completedAt: updatedAt,
  };

  await services.threads.createThread(thread);
  await insertTranscriptMessages(threadId, transcript, createdAt);

  services.wsBroker.emitToUser(userId, {
    type: 'thread:created',
    threadId,
    data: { projectId: project.id, title, source: 'ingest' },
  });

  return { ok: true, imported: true, thread };
}

async function ensureExternalClaudeThreadShell(params: {
  session: ExternalClaudeSession;
  projects: ClaudeProject[];
  userId: string;
  projectId?: string | null;
}): Promise<ExternalSessionThread | null> {
  const { session, projects, userId } = params;
  if (!session.sessionId) return null;

  const services = getServices();
  const existingBySessionId = await services.threads.getThreadBySessionId(session.sessionId);
  if (existingBySessionId) return existingBySessionId;

  const externalRequestId = `claude:${session.sessionId}`;
  const existingByExternalId =
    await services.threads.getThreadByExternalRequestId(externalRequestId);
  if (existingByExternalId) return existingByExternalId;

  const project =
    (params.projectId ? projects.find((candidate) => candidate.id === params.projectId) : null) ??
    (session.projectId ? projects.find((candidate) => candidate.id === session.projectId) : null) ??
    matchProjectForCwd(session.cwd, projects);
  if (!project) return null;

  const now = new Date().toISOString();
  const createdAt = session.startedAt ?? session.updatedAt ?? now;
  const updatedAt = session.updatedAt ?? createdAt;
  const title = session.title || session.projectName || project.name || 'Claude Code';
  const thread = {
    id: nanoid(),
    projectId: project.id,
    userId,
    title,
    mode: 'local',
    runtime: 'local',
    provider: 'claude',
    permissionMode: 'autoEdit',
    status: 'completed',
    stage: 'in_progress',
    model: DEFAULT_MODEL,
    branch: session.gitBranch,
    baseBranch: session.gitBranch,
    worktreePath: null,
    sessionId: session.sessionId,
    source: 'ingest',
    externalRequestId,
    createdBy: 'external',
    initialPrompt: session.lastPrompt ?? undefined,
    cost: 0,
    createdAt,
    updatedAt,
    completedAt: updatedAt,
  };

  await services.threads.createThread(thread);
  services.wsBroker.emitToUser(userId, {
    type: 'thread:created',
    threadId: thread.id,
    data: { projectId: project.id, title, source: 'ingest' },
  });
  return thread;
}

async function hydrateExternalClaudeThread(params: {
  thread: ExternalSessionThread;
  sessionId: string;
  userId: string;
  homeDir?: string;
}): Promise<ImportExternalClaudeSessionResult> {
  const { thread, sessionId, userId } = params;
  if (thread.userId && thread.userId !== userId) {
    return {
      ok: false,
      status: 404,
      error: 'External Claude Code session not found',
    };
  }

  const services = getServices();
  const existing = await services.threads.getThreadWithMessages(thread.id, 1);
  if (existing?.messages?.length) {
    return { ok: true, imported: false, thread };
  }

  const transcript = await readExternalClaudeTranscript(sessionId, {
    homeDir: params.homeDir,
  });
  if (!transcript) {
    return {
      ok: false,
      status: 404,
      error: 'External Claude Code session not found',
    };
  }

  await insertTranscriptMessages(
    thread.id,
    transcript,
    thread.createdAt ?? transcript.startedAt ?? new Date().toISOString(),
  );
  return { ok: true, imported: true, thread };
}

function serializeImages(images: ImageAttachment[] | undefined): string | null {
  return images?.length ? JSON.stringify(images) : null;
}

async function insertTranscriptMessages(
  threadId: string,
  transcript: ExternalClaudeTranscript,
  fallbackTimestamp: string,
): Promise<void> {
  const services = getServices();
  for (const message of transcript.messages) {
    const messageId = await services.threads.insertMessage({
      threadId,
      role: message.role,
      content: message.content,
      images: serializeImages(message.images),
      author: message.author ?? null,
      timestamp: message.timestamp ?? fallbackTimestamp,
    });

    for (const toolCall of message.toolCalls ?? []) {
      const toolCallId = await services.threads.insertToolCall({
        messageId,
        name: toolCall.name,
        input: toolCall.input,
        author: toolCall.author ?? CLAUDE_CODE_SYNTHETIC_AUTHOR,
      });
      if (toolCall.output) await services.threads.updateToolCallOutput(toolCallId, toolCall.output);
    }
  }
}

function getDismissedSessionIds(): Set<string> {
  if (dismissedSessionIdsCache) return dismissedSessionIdsCache;
  try {
    const raw = readFileSync(DISMISSED_SESSIONS_FILE, 'utf8');
    const parsed = parseStoredJson(
      dismissedSessionIdsSchema,
      raw,
      'Dismissed external Claude sessions',
    );
    dismissedSessionIdsCache = new Set(parsed.ok ? parsed.value : []);
  } catch {
    dismissedSessionIdsCache = new Set();
  }
  return dismissedSessionIdsCache;
}

function saveDismissedSessionIds(sessionIds: Set<string>): void {
  dismissedSessionIdsCache = sessionIds;
  mkdirSync(dirname(DISMISSED_SESSIONS_FILE), { recursive: true });
  writeFileSync(DISMISSED_SESSIONS_FILE, JSON.stringify(Array.from(sessionIds).sort(), null, 2));
}

async function listRunningExternalClaudeSessions(
  options: ExternalClaudeSessionOptions = {},
): Promise<ExternalClaudeSession[]> {
  const now = options.now ?? new Date();
  const currentPid = options.currentPid ?? process.pid;
  const homeDir = options.homeDir ?? homedir();
  const getCwd = options.getCwd ?? getProcessCwd;
  const psOutput = options.psOutput ?? (await readProcessTable());
  const processes = parsePsOutput(psOutput);
  const processByPid = new Map(processes.map((proc) => [proc.pid, proc]));
  const seen = new Set<string>();

  const externalProcesses = processes
    .filter(isClaudeCodeProcess)
    .filter((proc) => !isFunnyManagedProcess(proc, processByPid, currentPid));

  const sessions: ExternalClaudeSession[] = [];
  for (const proc of externalProcesses) {
    const cwd = await getCwd(proc.pid);
    const metadata = cwd ? await readClaudeSessionMetadata(homeDir, cwd) : null;
    const session = runningSession(proc, cwd, metadata, now);
    if (!session || seen.has(session.id)) continue;
    seen.add(session.id);
    sessions.push(session);
  }

  return sessions.sort(
    (a, b) =>
      (a.elapsedSeconds ?? Number.MAX_SAFE_INTEGER) - (b.elapsedSeconds ?? Number.MAX_SAFE_INTEGER),
  );
}

/** A running Claude Code process as a session; null inside a Funny worktree. */
function runningSession(
  proc: ProcessInfo,
  cwd: string | null,
  metadata: SessionMetadata | null,
  now: Date,
): ExternalClaudeSession | null {
  const effectiveCwd = metadata?.cwd ?? cwd;
  if (effectiveCwd && effectiveCwd.includes('/.funny-worktrees/')) return null;

  const sessionId = metadata?.sessionId ?? null;
  const projectName = effectiveCwd ? basename(effectiveCwd) : null;
  const startedAt =
    proc.elapsedSeconds === null
      ? null
      : new Date(now.getTime() - proc.elapsedSeconds * 1000).toISOString();

  return {
    id: sessionId ? `claude:${sessionId}` : `claude-pid:${proc.pid}`,
    source: 'claude-code' as const,
    pid: proc.pid,
    ppid: proc.ppid,
    isRunning: true,
    sessionId,
    cwd: effectiveCwd,
    projectName,
    gitBranch: metadata?.gitBranch ?? null,
    title: sessionTitle(metadata, projectName ?? 'Claude Code'),
    lastPrompt: metadata?.lastPrompt ?? null,
    command: proc.args,
    startedAt,
    elapsedSeconds: proc.elapsedSeconds,
    updatedAt: metadata?.updatedAt ?? null,
  };
}

async function listProjectClaudeSessions(
  options: ExternalClaudeSessionOptions,
  runningSessions: ExternalClaudeSession[],
): Promise<ExternalClaudeSession[]> {
  const homeDir = options.homeDir ?? homedir();
  const projects = options.projects ?? [];
  const runningBySessionId = new Map(
    runningSessions.flatMap((session) =>
      session.sessionId ? [[session.sessionId, session] as const] : [],
    ),
  );
  const sessionsById = new Map<string, ExternalClaudeSession>();

  for (const file of await listClaudeSessionFiles(homeDir)) {
    const metadata = await readSessionMetadata(file.path, file.sessionId);
    if (!metadata?.sessionId) continue;
    const project = matchProjectForCwd(metadata.cwd, projects);
    if (!project) continue;

    const running = runningBySessionId.get(metadata.sessionId);
    if (!running && !metadata.hasDisplayableContent) continue;
    const cwd = metadata.cwd ?? running?.cwd ?? null;
    const id = `claude:${metadata.sessionId}`;
    sessionsById.set(id, {
      id,
      source: 'claude-code',
      pid: running?.pid ?? null,
      ppid: running?.ppid ?? null,
      isRunning: !!running,
      sessionId: metadata.sessionId,
      cwd,
      projectId: project.id,
      projectName: project.name,
      gitBranch: metadata.gitBranch ?? running?.gitBranch ?? null,
      title: sessionTitle(metadata, running?.title ?? project.name),
      lastPrompt: metadata.lastPrompt ?? running?.lastPrompt ?? null,
      command: running?.command ?? null,
      startedAt: metadata.startedAt ?? running?.startedAt ?? null,
      elapsedSeconds: running?.elapsedSeconds ?? null,
      updatedAt: metadata.updatedAt ?? running?.updatedAt ?? null,
    });
  }

  return Array.from(sessionsById.values()).sort((a, b) => {
    const aTime = Date.parse(a.updatedAt ?? a.startedAt ?? '');
    const bTime = Date.parse(b.updatedAt ?? b.startedAt ?? '');
    return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
  });
}

export async function readExternalClaudeTranscript(
  sessionId: string,
  options: { homeDir?: string } = {},
): Promise<ExternalClaudeTranscript | null> {
  if (!isSafeSessionId(sessionId)) return null;

  const homeDir = options.homeDir ?? homedir();
  const file = await findClaudeSessionFile(homeDir, sessionId);
  if (!file) return null;

  const transcript: TranscriptState = {
    metadata: emptySessionMetadata(sessionId),
    messages: [],
    toolCallsByClaudeId: new Map(),
  };
  try {
    if ((await stat(file)).size > MAX_TRANSCRIPT_BYTES) return null;
    for await (const line of readFileLines(file)) foldTranscriptLine(transcript, line.text);
  } catch {
    return null;
  }

  const { metadata, messages } = transcript;

  const projectName = metadata.cwd ? basename(metadata.cwd) : null;
  return {
    sessionId: metadata.sessionId ?? sessionId,
    cwd: metadata.cwd,
    projectName,
    gitBranch: metadata.gitBranch,
    title: sessionTitle(metadata, projectName ?? 'Claude Code'),
    startedAt: metadata.startedAt,
    updatedAt: metadata.updatedAt,
    messages,
  };
}

interface TranscriptState {
  metadata: SessionMetadata;
  messages: ExternalClaudeTranscriptMessage[];
  toolCallsByClaudeId: Map<string, ExternalClaudeTranscriptToolCall>;
}

/** Fold one JSONL line into a transcript being read. */
function foldTranscriptLine(state: TranscriptState, line: string): void {
  const entry = parseJsonlEntry(line);
  if (!entry) return;
  const { metadata, messages } = state;
  applyEntryMetadata(metadata, entry);

  const message = entryToTranscriptMessage(entry, messages.length, state.toolCallsByClaudeId);
  if (!message) return;
  metadata.hasDisplayableContent = true;
  messages.push(message);
  if (message.role === 'user' && !metadata.lastPrompt) {
    metadata.lastPrompt = firstLine(message.content);
  }
}

function parseElapsed(value: string): number | null {
  const daySplit = value.split('-');
  const days = daySplit.length === 2 ? Number(daySplit[0]) : 0;
  const time = daySplit.length === 2 ? daySplit[1] : daySplit[0];
  const parts = time.split(':').map(Number);
  if (parts.some((part) => Number.isNaN(part))) return null;
  if (parts.length === 3) return days * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return days * 86400 + parts[0] * 60 + parts[1];
  return null;
}

/**
 * The process table from `ps`. Asynchronous: a sync spawn would stall the
 * runner's event loop (every agent stream, PTY and gRPC frame) until `ps` exits.
 */
async function readProcessTable(): Promise<string> {
  const args =
    process.platform === 'darwin'
      ? ['-axo', 'pid=,ppid=,etime=,comm=,args=']
      : ['-eo', 'pid=,ppid=,etime=,comm=,args='];
  try {
    const result = await execute('ps', args, {
      timeout: 3000,
      maxOutputBytes: 2 * 1024 * 1024,
      reject: false,
    });
    return result.exitCode === 0 ? result.stdout : '';
  } catch {
    // ps missing, timed out or produced too much output.
    return '';
  }
}

function isFunnyManagedProcess(
  proc: ProcessInfo,
  processByPid: Map<number, ProcessInfo>,
  currentPid: number,
): boolean {
  let ppid = proc.ppid;
  const visited = new Set<number>();

  while (ppid > 0 && !visited.has(ppid)) {
    if (ppid === currentPid) return true;
    visited.add(ppid);
    const parent = processByPid.get(ppid);
    if (!parent) return false;
    ppid = parent.ppid;
  }

  return false;
}

async function getProcessCwd(pid: number): Promise<string | null> {
  if (process.platform === 'linux') {
    try {
      return await readlink(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }

  if (process.platform === 'darwin') {
    try {
      const result = await execute('lsof', ['-a', '-d', 'cwd', '-p', String(pid), '-Fn'], {
        timeout: 1000,
        reject: false,
      });
      if (result.exitCode !== 0) return null;
      const line = result.stdout
        .split('\n')
        .find((entry) => entry.startsWith('n') && entry.length > 1);
      return line ? line.slice(1) : null;
    } catch {
      return null;
    }
  }

  return null;
}

async function readClaudeSessionMetadata(
  homeDir: string,
  cwd: string,
): Promise<SessionMetadata | null> {
  const projectDir = join(homeDir, CLAUDE_PROJECTS_DIR, encodeClaudeProjectPath(cwd));
  const files = (await listSessionFilesIn(projectDir))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_JSONL_FILES_PER_CWD);

  for (const file of files) {
    const metadata = await readSessionMetadata(file.path, file.sessionId);
    if (metadata) return metadata;
  }

  return null;
}

async function listClaudeSessionFiles(
  homeDir: string,
): Promise<Array<{ path: string; sessionId: string }>> {
  const files: SessionFile[] = [];
  for (const projectDir of await listClaudeProjectDirs(homeDir)) {
    files.push(...(await listSessionFilesIn(projectDir)));
  }

  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_PROJECT_SESSION_FILES)
    .map(({ path, sessionId }) => ({ path, sessionId }));
}

interface SessionFile {
  path: string;
  sessionId: string;
  mtimeMs: number;
}

/** Directories under `~/.claude/projects`; none when it does not exist. */
async function listClaudeProjectDirs(homeDir: string): Promise<string[]> {
  const projectsDir = join(homeDir, CLAUDE_PROJECTS_DIR);
  try {
    const entries = await readdir(projectsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => join(projectsDir, entry.name));
  } catch {
    return [];
  }
}

/** The `.jsonl` session files of one Claude project directory, with their mtimes. */
async function listSessionFilesIn(projectDir: string): Promise<SessionFile[]> {
  let names: string[];
  try {
    names = await readdir(projectDir);
  } catch {
    return [];
  }

  const files: SessionFile[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const path = join(projectDir, name);
    try {
      files.push({
        path,
        sessionId: name.replace(/\.jsonl$/, ''),
        mtimeMs: (await stat(path)).mtimeMs,
      });
    } catch {
      continue;
    }
  }
  return files;
}

/** Title shown for a session: Claude Code's generated title, else the last prompt. */
function sessionTitle(
  metadata: Pick<SessionMetadata, 'aiTitle' | 'lastPrompt'> | null,
  fallback: string,
): string {
  return metadata?.aiTitle ?? metadata?.lastPrompt ?? fallback;
}

type ClaudeJsonlEntry = z.infer<typeof claudeJsonlEntrySchema>;

function emptySessionMetadata(sessionId: string): SessionMetadata {
  return {
    sessionId,
    cwd: null,
    gitBranch: null,
    lastPrompt: null,
    aiTitle: null,
    startedAt: null,
    updatedAt: null,
    hasDisplayableContent: false,
  };
}

/** One line of a session JSONL file as an entry; null for blank and invalid lines. */
function parseJsonlEntry(line: string): ClaudeJsonlEntry | null {
  if (!line.trim()) return null;
  const parsed = parseStoredJson(claudeJsonlEntrySchema, line, 'Claude Code session JSONL');
  return parsed.ok ? parsed.value : null;
}

/** Fold one JSONL entry's session-level fields (ids, timestamps, prompt, title) into `metadata`. */
function applyEntryMetadata(metadata: SessionMetadata, entry: ClaudeJsonlEntry): void {
  applyEntryContext(metadata, entry);
  applyEntryTitles(metadata, entry);
}

/** Session id, cwd, branch and the first / last timestamps. */
function applyEntryContext(metadata: SessionMetadata, entry: ClaudeJsonlEntry): void {
  if (entry.sessionId) metadata.sessionId = entry.sessionId;
  if (entry.cwd) metadata.cwd = entry.cwd;
  if (entry.gitBranch) metadata.gitBranch = entry.gitBranch;
  if (entry.timestamp) {
    metadata.startedAt ??= entry.timestamp;
    metadata.updatedAt = entry.timestamp;
  }
}

/** `last-prompt` and `ai-title` entries. */
function applyEntryTitles(metadata: SessionMetadata, entry: ClaudeJsonlEntry): void {
  if (entry.type === 'last-prompt' && entry.lastPrompt) {
    const lastPrompt = contentToText(entry.lastPrompt);
    if (lastPrompt) metadata.lastPrompt = lastPrompt;
  }
  const aiTitle = entry.type === 'ai-title' ? entry.aiTitle?.trim() : undefined;
  if (aiTitle) metadata.aiTitle = aiTitle;
}

interface CachedSessionMetadata {
  size: number;
  mtimeMs: number;
  /** Byte offset past the last complete line folded into `committed`. */
  offset: number;
  /** Metadata of the complete lines, the state a later read resumes from. */
  committed: SessionMetadata;
  /** `committed` plus an unterminated last line, if the file had one: what callers get. */
  current: SessionMetadata;
}

/**
 * Session metadata by file path. Claude Code only appends to a session file, so a
 * file that grew is read from where the last read stopped instead of from the start.
 */
const sessionMetadataCache = new Map<string, CachedSessionMetadata>();

/** Session-level metadata of a JSONL file, read asynchronously and incrementally. */
async function readSessionMetadata(
  path: string,
  fallbackSessionId: string,
): Promise<SessionMetadata | null> {
  const cached = sessionMetadataCache.get(path);
  sessionMetadataCache.delete(path);

  let entry: CachedSessionMetadata;
  try {
    const stats = await stat(path);
    const unchanged = cached?.size === stats.size && cached.mtimeMs === stats.mtimeMs;
    entry = unchanged
      ? cached
      : await readSessionMetadataFrom(path, stats, cached, fallbackSessionId);
  } catch {
    return null;
  }

  // Re-inserted last, so the map's first key is the least recently read file.
  sessionMetadataCache.set(path, entry);
  if (sessionMetadataCache.size > MAX_CACHED_SESSION_FILES) {
    const oldest = sessionMetadataCache.keys().next().value;
    if (oldest !== undefined) sessionMetadataCache.delete(oldest);
  }
  return { ...entry.current };
}

/** Read a changed session file, resuming after `cached` when the file only grew. */
async function readSessionMetadataFrom(
  path: string,
  stats: { size: number; mtimeMs: number },
  cached: CachedSessionMetadata | undefined,
  fallbackSessionId: string,
): Promise<CachedSessionMetadata> {
  // A file that shrank was rewritten: read it again from the start.
  const resume = cached && stats.size >= cached.offset ? cached : null;
  const committed = resume ? { ...resume.committed } : emptySessionMetadata(fallbackSessionId);
  let offset = resume?.offset ?? 0;
  let current = committed;

  for await (const line of readFileLines(path, offset)) {
    if (line.end === null) {
      // Claude Code may still be writing this line: count it now, read it again next time.
      current = { ...committed };
      foldSessionMetadataLine(current, line.text);
    } else {
      foldSessionMetadataLine(committed, line.text);
      offset = line.end;
    }
  }

  return { size: stats.size, mtimeMs: stats.mtimeMs, offset, committed, current };
}

/** Fold one JSONL line into the session-level metadata. */
function foldSessionMetadataLine(metadata: SessionMetadata, line: string): void {
  const entry = parseJsonlEntry(line);
  if (!entry) return;

  applyEntryMetadata(metadata, entry);
  const message = entry.message;
  if (!metadata.lastPrompt && entry.type === 'user' && message?.content !== undefined) {
    metadata.lastPrompt = firstLine(contentToText(message.content));
  }
  if (!metadata.hasDisplayableContent) {
    // A tool result only fills a card of an earlier tool_use, and a tool_use already makes
    // the session displayable, so no tool calls need to be remembered across lines.
    metadata.hasDisplayableContent = !!entryToTranscriptMessage(entry, 0, new Map());
  }
}

function matchProjectForCwd<T extends ClaudeProject>(
  cwd: string | null | undefined,
  projects: T[],
): T | null {
  if (!cwd) return null;
  const normalizedCwd = normalizePath(cwd);
  let best: T | null = null;

  for (const project of projects) {
    const projectPath = normalizePath(project.path);
    if (normalizedCwd !== projectPath && !normalizedCwd.startsWith(`${projectPath}/`)) continue;
    if (!best || projectPath.length > normalizePath(best.path).length) best = project;
  }

  return best;
}

function normalizePath(path: string): string {
  return path.replace(/\/+$/, '');
}

function firstUserPrompt(transcript: ExternalClaudeTranscript): string | null {
  return transcript.messages.find((message) => message.role === 'user')?.content ?? null;
}

function encodeClaudeProjectPath(cwd: string): string {
  return cwd.replace(/[\\/]/g, '-');
}

async function findClaudeSessionFile(homeDir: string, sessionId: string): Promise<string | null> {
  for (const projectDir of await listClaudeProjectDirs(homeDir)) {
    const candidate = join(projectDir, `${sessionId}.jsonl`);
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      continue;
    }
  }

  return null;
}

function isSafeSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(sessionId);
}

function summaryTranscriptMessage(
  entry: z.infer<typeof claudeJsonlEntrySchema>,
  index: number,
): ExternalClaudeTranscriptMessage | null {
  if (entry.type === 'summary' && entry.summary) {
    return {
      id: entry.uuid ?? `summary-${index}`,
      role: 'system',
      content: entry.summary,
      timestamp: entry.timestamp ?? null,
    };
  }
  return null;
}

/**
 * Newer Claude Code versions also log the raw API request (`api-request-blob`: system
 * prompt, tool definitions, reminders, a copy of the assistant turn) with a
 * `message.role`; only `user` / `assistant` entries are conversation.
 */
function isConversationEntry(entry: z.infer<typeof claudeJsonlEntrySchema>): boolean {
  return entry.type === 'user' || entry.type === 'assistant';
}

function entryToTranscriptMessage(
  entry: z.infer<typeof claudeJsonlEntrySchema>,
  index: number,
  toolCallsByClaudeId: Map<string, ExternalClaudeTranscriptToolCall>,
): ExternalClaudeTranscriptMessage | null {
  // Besides summaries, only conversation entries are messages.
  if (!isConversationEntry(entry)) return summaryTranscriptMessage(entry, index);

  const message = entry.message;
  const role = message?.role;
  if (!role || message.content === undefined) return null;

  if (role === 'user' && contentLooksLikeToolResult(message.content)) {
    return toolResultTranscriptMessage(entry, message.content, index, toolCallsByClaudeId);
  }

  const content = contentToText(message.content);
  const parts =
    role === 'user'
      ? userMessageParts(entry, message.content, content)
      : { toolCalls: extractToolCalls(message.content, entry, index, toolCallsByClaudeId) };
  if (!parts || !hasVisibleContent(content, parts)) return null;

  return {
    id: entry.uuid ?? `${role}-${index}`,
    role,
    content,
    ...withoutEmptyLists(parts),
    timestamp: entry.timestamp ?? null,
  };
}

/** A user turn of bare tool results: fills earlier tool cards, keeping only orphans. */
function toolResultTranscriptMessage(
  entry: z.infer<typeof claudeJsonlEntrySchema>,
  content: unknown,
  index: number,
  toolCallsByClaudeId: Map<string, ExternalClaudeTranscriptToolCall>,
): ExternalClaudeTranscriptMessage | null {
  const orphanToolCalls = applyToolResults(content, entry, index, toolCallsByClaudeId);
  if (orphanToolCalls.length === 0) return null;
  return {
    id: entry.uuid ?? `tool-results-${index}`,
    role: 'assistant',
    content: '',
    timestamp: entry.timestamp ?? null,
    toolCalls: orphanToolCalls,
  };
}

function hasVisibleContent(
  content: string,
  parts: Pick<ExternalClaudeTranscriptMessage, 'images' | 'toolCalls'>,
): boolean {
  return content.trim().length > 0 || !!parts.toolCalls?.length || !!parts.images?.length;
}

/** Attachments and authorship of a user turn, or null when the turn is not shown. */
function userMessageParts(
  entry: z.infer<typeof claudeJsonlEntrySchema>,
  rawContent: unknown,
  content: string,
): Pick<ExternalClaudeTranscriptMessage, 'images' | 'author' | 'toolCalls'> | null {
  if (!entry.isMeta) return { images: extractImages(rawContent) };
  // Claude Code follows a pasted image with a meta note holding only its temp path.
  if (IMAGE_SOURCE_NOTE_RE.test(content)) return null;
  return { images: extractImages(rawContent), author: CLAUDE_CODE_SYNTHETIC_AUTHOR };
}

function withoutEmptyLists<T extends Record<string, unknown>>(parts: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(parts).filter(([, value]) => !Array.isArray(value) || value.length > 0),
  ) as Partial<T>;
}

/**
 * A content block of a transcript line, as parsed from the JSONL file: the
 * fields read here, each checked before use.
 */
interface TranscriptContentBlock {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  content?: unknown;
  tool_use_id?: unknown;
  text?: unknown;
}

function extractToolCalls(
  content: unknown,
  entry: z.infer<typeof claudeJsonlEntrySchema>,
  index: number,
  toolCallsByClaudeId: Map<string, ExternalClaudeTranscriptToolCall>,
): ExternalClaudeTranscriptToolCall[] {
  if (!Array.isArray(content)) return [];

  const toolCalls: ExternalClaudeTranscriptToolCall[] = [];
  content.forEach((block, blockIndex) => {
    if (!block || typeof block !== 'object') return;
    // SAFETY: `block` is a non-null object; every field is read as unknown and checked.
    const record = block as TranscriptContentBlock;
    if (record.type !== 'tool_use') return;

    const claudeToolId = typeof record.id === 'string' ? record.id : null;
    const toolCall: ExternalClaudeTranscriptToolCall = {
      id: claudeToolId ?? `${entry.uuid ?? `assistant-${index}`}-tool-${blockIndex}`,
      name: typeof record.name === 'string' && record.name ? record.name : 'Tool',
      input: stringifyToolInput(record.input),
      timestamp: entry.timestamp ?? null,
      author: 'Claude Code',
    };
    toolCalls.push(toolCall);
    if (claudeToolId) toolCallsByClaudeId.set(claudeToolId, toolCall);
  });

  return toolCalls;
}

function applyToolResults(
  content: unknown,
  entry: z.infer<typeof claudeJsonlEntrySchema>,
  index: number,
  toolCallsByClaudeId: Map<string, ExternalClaudeTranscriptToolCall>,
): ExternalClaudeTranscriptToolCall[] {
  if (!Array.isArray(content)) return [];

  const orphanToolCalls: ExternalClaudeTranscriptToolCall[] = [];
  content.forEach((block, blockIndex) => {
    if (!block || typeof block !== 'object') return;
    // SAFETY: `block` is a non-null object; every field is read as unknown and checked.
    const record = block as TranscriptContentBlock;
    if (record.type !== 'tool_result') return;

    const output = contentToText(record.content);
    const claudeToolId = typeof record.tool_use_id === 'string' ? record.tool_use_id : null;
    const existing = claudeToolId ? toolCallsByClaudeId.get(claudeToolId) : null;
    if (existing) {
      existing.output = output;
      return;
    }

    orphanToolCalls.push({
      id: claudeToolId ?? `${entry.uuid ?? `tool-result-${index}`}-tool-${blockIndex}`,
      name: 'ToolResult',
      input: '{}',
      output,
      timestamp: entry.timestamp ?? null,
      author: 'Claude Code',
    });
  });

  return orphanToolCalls;
}

function contentToText(content: unknown): string {
  const text =
    typeof content === 'string'
      ? content
      : !Array.isArray(content)
        ? stringifyUnknown(content)
        : content
            .map((block) => blockToText(block))
            .filter(Boolean)
            .join('\n\n');

  return stripClaudeInternalPromptMarkers(stripIdeOpenedFileMarkers(text));
}

function extractImages(content: unknown): ImageAttachment[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block): ImageAttachment[] => {
    const parsed = imageBlockSchema.safeParse(block);
    return parsed.success ? [parsed.data] : [];
  });
}

function blockToText(block: unknown): string {
  if (typeof block === 'string') return block;
  if (!block || typeof block !== 'object') return stringifyUnknown(block);

  // SAFETY: `block` is a non-null object; every field is read as unknown and checked.
  const record = block as TranscriptContentBlock;
  const type = typeof record.type === 'string' ? record.type : null;

  if (type === 'text' && typeof record.text === 'string') return record.text;
  if (type && NON_TEXT_BLOCK_TYPES.has(type)) return '';
  if (type === 'tool_result') {
    return `Tool result\n\n${contentToText(record.content)}`;
  }

  if (typeof record.text === 'string') return record.text;
  if (typeof record.content === 'string') return record.content;
  return stringifyUnknown(record);
}

function contentLooksLikeToolResult(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every(
      (block) =>
        !!block &&
        typeof block === 'object' &&
        // SAFETY: `block` is a non-null object; `type` is compared, not trusted.
        (block as TranscriptContentBlock).type === 'tool_result',
    )
  );
}

function stringifyToolInput(input: unknown): string {
  if (input === null || input === undefined) return '{}';
  if (typeof input === 'string') return input;
  return stringifyUnknown(input) || '{}';
}

function stringifyUnknown(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function stripIdeOpenedFileMarkers(value: string): string {
  if (!value.includes('<ide_opened_file>')) return value;
  return value
    .replace(IDE_OPENED_FILE_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripClaudeInternalPromptMarkers(value: string): string {
  if (!containsClaudeInternalPromptMarker(value)) return value;

  const trimmedStart = value.trimStart();
  if (trimmedStart.startsWith(CONTEXT_RECOVERY_PREFIX)) {
    const markerIndex = trimmedStart.lastIndexOf(RECOVERED_USER_MESSAGE_MARKER);
    if (markerIndex === -1) return '';
    return trimmedStart
      .slice(markerIndex + RECOVERED_USER_MESSAGE_MARKER.length)
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  if (trimmedStart.startsWith(RESUME_NOTE_PREFIX)) {
    const noteEnd = trimmedStart.indexOf(']');
    return (noteEnd === -1 ? '' : trimmedStart.slice(noteEnd + 1))
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  const stripped = value
    .replace(PREVIEWABLE_ASSETS_BLOCK_RE, '')
    .replace(LOCAL_COMMAND_CAVEAT_BLOCK_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const remaining = stripped.trimStart();
  if (
    remaining.startsWith('[PREVIEWABLE ASSETS]') ||
    remaining.startsWith('<local-command-caveat>')
  ) {
    return '';
  }

  return stripped;
}

function containsClaudeInternalPromptMarker(value: string): boolean {
  return (
    value.includes('[PREVIEWABLE ASSETS]') ||
    value.includes('<local-command-caveat>') ||
    value.includes(CONTEXT_RECOVERY_PREFIX) ||
    value.includes(RESUME_NOTE_PREFIX)
  );
}

function firstLine(value: string): string | null {
  const line = value
    .split('\n')
    .map((part) => part.trim())
    .find(Boolean);
  return line ? line.slice(0, 160) : null;
}
