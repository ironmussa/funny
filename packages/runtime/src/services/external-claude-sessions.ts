import { spawnSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { basename, dirname, join } from 'path';

import { parseStoredJson } from '@funny/shared/json-validation';
import { DEFAULT_MODEL } from '@funny/shared/models';
import { nanoid } from 'nanoid';
import { z } from 'zod';

import { DATA_DIR } from '../lib/data-dir.js';
import { getServices } from './service-registry.js';

const CLAUDE_PROJECTS_DIR = '.claude/projects';
const DISMISSED_SESSIONS_FILE = join(DATA_DIR, 'external-claude-dismissed.json');
const MAX_JSONL_FILES_PER_CWD = 8;
const MAX_PROJECT_SESSION_FILES = 200;
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
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
let dismissedSessionIdsCache: Set<string> | null = null;

const dismissedSessionIdsSchema = z.array(z.string());

const claudeJsonlEntrySchema = z
  .object({
    type: z.string().optional(),
    sessionId: z.string().optional(),
    cwd: z.string().optional(),
    gitBranch: z.string().optional(),
    timestamp: z.string().optional(),
    lastPrompt: z.string().optional(),
    summary: z.string().optional(),
    uuid: z.string().optional(),
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

export interface ExternalClaudeSession {
  id: string;
  source: 'claude-code';
  pid: number | null;
  ppid: number | null;
  isRunning: boolean;
  sessionId: string | null;
  cwd: string | null;
  projectId?: string | null;
  projectName: string | null;
  gitBranch: string | null;
  title: string;
  lastPrompt: string | null;
  command: string | null;
  startedAt: string | null;
  elapsedSeconds: number | null;
  updatedAt: string | null;
}

export interface ExternalClaudeTranscriptMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string | null;
  author?: string | null;
  toolCalls?: ExternalClaudeTranscriptToolCall[];
}

export interface ExternalClaudeTranscriptToolCall {
  id: string;
  name: string;
  input: string;
  output?: string;
  timestamp: string | null;
  author?: string;
}

export interface ExternalClaudeTranscript {
  sessionId: string;
  cwd: string | null;
  projectName: string | null;
  gitBranch: string | null;
  title: string;
  startedAt: string | null;
  updatedAt: string | null;
  messages: ExternalClaudeTranscriptMessage[];
}

interface SessionMetadata {
  sessionId: string | null;
  cwd: string | null;
  gitBranch: string | null;
  lastPrompt: string | null;
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
  getCwd?: (pid: number) => string | null;
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

export function listExternalClaudeSessions(
  options: ExternalClaudeSessionOptions = {},
): ExternalClaudeSession[] {
  const runningSessions = listRunningExternalClaudeSessions(options);
  if (options.projects?.length) {
    return listProjectClaudeSessions(options, runningSessions);
  }
  return runningSessions;
}

export async function listImportableExternalClaudeSessions(params: {
  userId: string;
  projectId?: string | null;
}): Promise<ExternalClaudeSession[]> {
  const services = getServices();
  const allProjects = await services.projects.listProjects(params.userId);
  const projects = params.projectId
    ? allProjects.filter((project) => project.id === params.projectId)
    : allProjects;
  if (projects.length === 0) return [];

  const sessions = listExternalClaudeSessions({ projects });
  const importable = await Promise.all(
    sessions.map(async (session) => {
      if (!session.sessionId) return null;
      const externalRequestId = `claude:${session.sessionId}`;
      const existingByExternalId =
        await services.threads.getThreadByExternalRequestId(externalRequestId);
      if (existingByExternalId) return null;

      const existingBySessionId = await services.threads.getThreadBySessionId(session.sessionId);
      return existingBySessionId ? null : session;
    }),
  );

  return importable.filter((session): session is ExternalClaudeSession => session !== null);
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

  const sessions = listExternalClaudeSessions({ ...options, projects });
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

export type ImportExternalClaudeSessionResult =
  | { ok: true; imported: boolean; thread: Record<string, any> }
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

  const existingBySessionId = await services.threads.getThreadBySessionId(sessionId);
  if (existingBySessionId) {
    return hydrateExternalClaudeThread({
      thread: existingBySessionId,
      sessionId,
      userId,
      homeDir: options.homeDir,
    });
  }

  const transcript = readExternalClaudeTranscript(sessionId, options);
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
}): Promise<Record<string, any> | null> {
  const { session, projects, userId } = params;
  if (!session.sessionId) return null;

  const services = getServices();
  const externalRequestId = `claude:${session.sessionId}`;
  const existingByExternalId =
    await services.threads.getThreadByExternalRequestId(externalRequestId);
  if (existingByExternalId) return existingByExternalId;

  const existingBySessionId = await services.threads.getThreadBySessionId(session.sessionId);
  if (existingBySessionId) return existingBySessionId;

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
  thread: Record<string, any>;
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

  const transcript = readExternalClaudeTranscript(sessionId, {
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
      author: message.author ?? (message.role === 'user' ? null : CLAUDE_CODE_SYNTHETIC_AUTHOR),
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

function listRunningExternalClaudeSessions(
  options: ExternalClaudeSessionOptions = {},
): ExternalClaudeSession[] {
  const now = options.now ?? new Date();
  const currentPid = options.currentPid ?? process.pid;
  const homeDir = options.homeDir ?? homedir();
  const getCwd = options.getCwd ?? getProcessCwd;
  const psOutput = options.psOutput ?? readProcessTable();
  const processes = parsePsOutput(psOutput);
  const processByPid = new Map(processes.map((proc) => [proc.pid, proc]));
  const seen = new Set<string>();

  return processes
    .filter(isClaudeCodeProcess)
    .filter((proc) => !isFunnyManagedProcess(proc, processByPid, currentPid))
    .map((proc): ExternalClaudeSession | null => {
      const cwd = getCwd(proc.pid);
      const metadata = cwd ? readClaudeSessionMetadata(homeDir, cwd) : null;
      const effectiveCwd = metadata?.cwd ?? cwd;

      if (effectiveCwd && effectiveCwd.includes('/.funny-worktrees/')) return null;

      const sessionId = metadata?.sessionId ?? null;
      const id = sessionId ? `claude:${sessionId}` : `claude-pid:${proc.pid}`;
      if (seen.has(id)) return null;
      seen.add(id);

      const projectName = effectiveCwd ? basename(effectiveCwd) : null;
      const startedAt =
        proc.elapsedSeconds === null
          ? null
          : new Date(now.getTime() - proc.elapsedSeconds * 1000).toISOString();

      return {
        id,
        source: 'claude-code' as const,
        pid: proc.pid,
        ppid: proc.ppid,
        isRunning: true,
        sessionId,
        cwd: effectiveCwd,
        projectName,
        gitBranch: metadata?.gitBranch ?? null,
        title: metadata?.lastPrompt ?? projectName ?? 'Claude Code',
        lastPrompt: metadata?.lastPrompt ?? null,
        command: proc.args,
        startedAt,
        elapsedSeconds: proc.elapsedSeconds,
        updatedAt: metadata?.updatedAt ?? null,
      };
    })
    .filter((session): session is ExternalClaudeSession => session !== null)
    .sort(
      (a, b) =>
        (a.elapsedSeconds ?? Number.MAX_SAFE_INTEGER) -
        (b.elapsedSeconds ?? Number.MAX_SAFE_INTEGER),
    );
}

function listProjectClaudeSessions(
  options: ExternalClaudeSessionOptions,
  runningSessions: ExternalClaudeSession[],
): ExternalClaudeSession[] {
  const homeDir = options.homeDir ?? homedir();
  const projects = options.projects ?? [];
  const runningBySessionId = new Map(
    runningSessions
      .filter((session) => session.sessionId)
      .map((session) => [session.sessionId as string, session]),
  );
  const sessionsById = new Map<string, ExternalClaudeSession>();

  for (const file of listClaudeSessionFiles(homeDir)) {
    const metadata = parseClaudeJsonl(file.path, file.sessionId);
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
      title: metadata.lastPrompt ?? running?.title ?? project.name,
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

export function readExternalClaudeTranscript(
  sessionId: string,
  options: { homeDir?: string } = {},
): ExternalClaudeTranscript | null {
  if (!isSafeSessionId(sessionId)) return null;

  const homeDir = options.homeDir ?? homedir();
  const file = findClaudeSessionFile(homeDir, sessionId);
  if (!file) return null;

  let raw = '';
  try {
    const stats = statSync(file);
    if (stats.size > MAX_TRANSCRIPT_BYTES) return null;
    raw = readFileSync(file, 'utf8');
  } catch {
    return null;
  }

  const messages: ExternalClaudeTranscriptMessage[] = [];
  const toolCallsByClaudeId = new Map<string, ExternalClaudeTranscriptToolCall>();
  const metadata: SessionMetadata = {
    sessionId,
    cwd: null,
    gitBranch: null,
    lastPrompt: null,
    startedAt: null,
    updatedAt: null,
    hasDisplayableContent: false,
  };
  let startedAt: string | null = null;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const parsed = parseStoredJson(claudeJsonlEntrySchema, line, 'Claude Code session JSONL');
    if (!parsed.ok) continue;

    const entry = parsed.value;
    if (entry.sessionId) metadata.sessionId = entry.sessionId;
    if (entry.cwd) metadata.cwd = entry.cwd;
    if (entry.gitBranch) metadata.gitBranch = entry.gitBranch;
    if (entry.timestamp) {
      startedAt ??= entry.timestamp;
      metadata.updatedAt = entry.timestamp;
    }
    if (entry.type === 'last-prompt' && entry.lastPrompt) {
      const lastPrompt = contentToText(entry.lastPrompt);
      if (lastPrompt) metadata.lastPrompt = lastPrompt;
    }

    const message = entryToTranscriptMessage(entry, messages.length, toolCallsByClaudeId);
    if (message) {
      metadata.hasDisplayableContent = true;
      messages.push(message);
      if (message.role === 'user' && !metadata.lastPrompt) {
        metadata.lastPrompt = firstLine(message.content);
      }
    }
  }

  const projectName = metadata.cwd ? basename(metadata.cwd) : null;
  return {
    sessionId: metadata.sessionId ?? sessionId,
    cwd: metadata.cwd,
    projectName,
    gitBranch: metadata.gitBranch,
    title: metadata.lastPrompt ?? projectName ?? 'Claude Code',
    startedAt,
    updatedAt: metadata.updatedAt,
    messages,
  };
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

function readProcessTable(): string {
  const args =
    process.platform === 'darwin'
      ? ['-axo', 'pid=,ppid=,etime=,comm=,args=']
      : ['-eo', 'pid=,ppid=,etime=,comm=,args='];
  const result = spawnSync('ps', args, {
    encoding: 'utf8',
    timeout: 3000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return result.status === 0 ? result.stdout : '';
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

function getProcessCwd(pid: number): string | null {
  if (process.platform === 'linux') {
    try {
      return readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }

  if (process.platform === 'darwin') {
    const result = spawnSync('lsof', ['-a', '-d', 'cwd', '-p', String(pid), '-Fn'], {
      encoding: 'utf8',
      timeout: 1000,
    });
    if (result.status !== 0) return null;
    const line = result.stdout
      .split('\n')
      .find((entry) => entry.startsWith('n') && entry.length > 1);
    return line ? line.slice(1) : null;
  }

  return null;
}

function readClaudeSessionMetadata(homeDir: string, cwd: string): SessionMetadata | null {
  const projectDir = join(homeDir, CLAUDE_PROJECTS_DIR, encodeClaudeProjectPath(cwd));
  if (!existsSync(projectDir)) return null;

  const files = readdirSync(projectDir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => {
      const path = join(projectDir, name);
      return { path, name, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_JSONL_FILES_PER_CWD);

  for (const file of files) {
    const metadata = parseClaudeJsonl(file.path, file.name.replace(/\.jsonl$/, ''));
    if (metadata) return metadata;
  }

  return null;
}

function listClaudeSessionFiles(homeDir: string): Array<{ path: string; sessionId: string }> {
  const projectsDir = join(homeDir, CLAUDE_PROJECTS_DIR);
  if (!existsSync(projectsDir)) return [];

  const files: Array<{ path: string; sessionId: string; mtimeMs: number }> = [];
  for (const projectName of readdirSync(projectsDir)) {
    const projectDir = join(projectsDir, projectName);
    try {
      if (!statSync(projectDir).isDirectory()) continue;
    } catch {
      continue;
    }

    for (const name of readdirSync(projectDir)) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(projectDir, name);
      try {
        files.push({
          path,
          sessionId: name.replace(/\.jsonl$/, ''),
          mtimeMs: statSync(path).mtimeMs,
        });
      } catch {
        continue;
      }
    }
  }

  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_PROJECT_SESSION_FILES)
    .map(({ path, sessionId }) => ({ path, sessionId }));
}

function parseClaudeJsonl(path: string, fallbackSessionId: string): SessionMetadata | null {
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }

  const metadata: SessionMetadata = {
    sessionId: fallbackSessionId,
    cwd: null,
    gitBranch: null,
    lastPrompt: null,
    startedAt: null,
    updatedAt: null,
    hasDisplayableContent: false,
  };
  const toolCallsByClaudeId = new Map<string, ExternalClaudeTranscriptToolCall>();

  for (const [index, line] of raw.split('\n').entries()) {
    if (!line.trim()) continue;
    const parsed = parseStoredJson(claudeJsonlEntrySchema, line, 'Claude Code session JSONL');
    if (!parsed.ok) continue;
    const entry = parsed.value;
    if (entry.sessionId) metadata.sessionId = entry.sessionId;
    if (entry.cwd) metadata.cwd = entry.cwd;
    if (entry.gitBranch) metadata.gitBranch = entry.gitBranch;
    if (entry.timestamp) {
      metadata.startedAt ??= entry.timestamp;
      metadata.updatedAt = entry.timestamp;
    }
    if (entry.type === 'last-prompt' && entry.lastPrompt) {
      const lastPrompt = contentToText(entry.lastPrompt);
      if (lastPrompt) metadata.lastPrompt = lastPrompt;
    }
    const message = entry.message;
    if (!metadata.lastPrompt && entry.type === 'user' && message?.content !== undefined) {
      metadata.lastPrompt = firstLine(contentToText(message.content));
    }
    if (!metadata.hasDisplayableContent) {
      metadata.hasDisplayableContent = !!entryToTranscriptMessage(
        entry,
        index,
        toolCallsByClaudeId,
      );
    }
  }

  return metadata;
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

function findClaudeSessionFile(homeDir: string, sessionId: string): string | null {
  const projectsDir = join(homeDir, CLAUDE_PROJECTS_DIR);
  if (!existsSync(projectsDir)) return null;

  for (const projectName of readdirSync(projectsDir)) {
    const projectDir = join(projectsDir, projectName);
    try {
      if (!statSync(projectDir).isDirectory()) continue;
    } catch {
      continue;
    }

    const candidate = join(projectDir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

function isSafeSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(sessionId);
}

function entryToTranscriptMessage(
  entry: z.infer<typeof claudeJsonlEntrySchema>,
  index: number,
  toolCallsByClaudeId: Map<string, ExternalClaudeTranscriptToolCall>,
): ExternalClaudeTranscriptMessage | null {
  if (entry.type === 'summary' && entry.summary) {
    return {
      id: entry.uuid ?? `summary-${index}`,
      role: 'system',
      content: entry.summary,
      timestamp: entry.timestamp ?? null,
    };
  }

  const message = entry.message;
  const role = message?.role;
  if (!role || message.content === undefined) return null;

  if (role === 'user' && contentLooksLikeToolResult(message.content)) {
    const orphanToolCalls = applyToolResults(message.content, entry, index, toolCallsByClaudeId);
    if (orphanToolCalls.length === 0) return null;
    return {
      id: entry.uuid ?? `tool-results-${index}`,
      role: 'assistant',
      content: '',
      timestamp: entry.timestamp ?? null,
      toolCalls: orphanToolCalls,
    };
  }

  const assistantToolCalls =
    role === 'assistant'
      ? extractToolCalls(message.content, entry, index, toolCallsByClaudeId)
      : [];
  const content = contentToText(message.content);
  if (!content.trim() && assistantToolCalls.length === 0) return null;

  return {
    id: entry.uuid ?? `${role}-${index}`,
    role,
    content,
    timestamp: entry.timestamp ?? null,
    ...(assistantToolCalls.length > 0 ? { toolCalls: assistantToolCalls } : {}),
  };
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
    const record = block as Record<string, unknown>;
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
    const record = block as Record<string, unknown>;
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

function blockToText(block: unknown): string {
  if (typeof block === 'string') return block;
  if (!block || typeof block !== 'object') return stringifyUnknown(block);

  const record = block as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : null;

  if (type === 'text' && typeof record.text === 'string') return record.text;
  if (type === 'thinking' || type === 'redacted_thinking' || type === 'tool_use') return '';
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
        (block as Record<string, unknown>).type === 'tool_result',
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
