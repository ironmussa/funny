/** External Claude Code sessions discovered on a runner (`~/.claude/projects`). */
import type { ImageAttachment } from '../types.js';

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
  images?: ImageAttachment[];
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
