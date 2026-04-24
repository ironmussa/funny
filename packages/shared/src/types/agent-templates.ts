import type { DeepAgentModel } from '../types.js';
import type { McpServer } from './mcp.js';

// ─── Agent Templates ───────────────────────────────────

export type SystemPromptMode = 'replace' | 'prepend' | 'append';

/** Deep Agent built-in tools that can be toggled on/off. */
export const DEEPAGENT_TOOLS = [
  'read_file',
  'write_file',
  'edit_file',
  'ls',
  'glob',
  'grep',
  'execute',
  'task',
  'write_todos',
  'compact_conversation',
] as const;
export type DeepAgentTool = (typeof DEEPAGENT_TOOLS)[number];

/** A user-fillable variable in a template's system prompt. */
export interface TemplateVariable {
  name: string;
  description?: string;
  defaultValue?: string;
}

/**
 * A reusable agent configuration template (global, per-user).
 * Only applicable when the harness/provider is `deepagent`.
 */
export interface AgentTemplate {
  id: string;
  userId: string;

  // Identity
  name: string;
  description?: string;
  icon?: string;
  color?: string;

  // Model (provider is always deepagent)
  model?: DeepAgentModel;

  // System Prompt
  systemPromptMode: SystemPromptMode;
  systemPrompt?: string;

  // Tools (deny list from DEEPAGENT_TOOLS)
  disallowedTools?: DeepAgentTool[];

  // MCP Servers (additive to project-level servers)
  mcpServers?: McpServer[];

  // Skills
  builtinSkillsDisabled?: string[];
  customSkillPaths?: string[];

  // Memory
  memoryOverride?: boolean | null;
  customMemoryPaths?: string[];

  // Deep Agent identity
  agentName?: string;

  // Sharing
  shared?: boolean;

  // Variables (user-fillable placeholders in system prompt)
  variables?: TemplateVariable[];

  // Meta
  createdAt: string;
  updatedAt: string;
}

export interface CreateAgentTemplateRequest {
  name: string;
  description?: string;
  icon?: string;
  color?: string;
  model?: DeepAgentModel;
  systemPromptMode?: SystemPromptMode;
  systemPrompt?: string;
  disallowedTools?: DeepAgentTool[];
  mcpServers?: McpServer[];
  builtinSkillsDisabled?: string[];
  customSkillPaths?: string[];
  memoryOverride?: boolean | null;
  customMemoryPaths?: string[];
  agentName?: string;
  shared?: boolean;
  variables?: TemplateVariable[];
}

export type UpdateAgentTemplateRequest = Partial<CreateAgentTemplateRequest>;

/** Shape of a JSON file used for importing/exporting templates. */
export interface AgentTemplateExportFile {
  version: 1;
  template: CreateAgentTemplateRequest;
}

// ─── Built-in Starter Templates ────────────────────────────

/**
 * Built-in starter templates that ship with the app.
 * IDs are prefixed with `__builtin__` to avoid collisions with user-created templates.
 * Users cannot edit or delete these — they can only duplicate them.
 */
export const BUILTIN_AGENT_TEMPLATES: AgentTemplate[] = [
  {
    id: '__builtin__code-reviewer',
    userId: '__system__',
    name: 'Code Reviewer',
    description:
      'Reviews code for bugs, security issues, and best practices. Read-only — cannot modify files.',
    color: '#7CB9E8',
    systemPromptMode: 'prepend',
    systemPrompt:
      'You are a code reviewer. Focus on identifying bugs, security vulnerabilities, performance issues, and deviations from best practices. Provide clear, actionable feedback. Do NOT modify any files — only read and analyze.',
    disallowedTools: ['write_file', 'edit_file', 'execute'],
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  },
  {
    id: '__builtin__planner',
    userId: '__system__',
    name: 'Planner',
    description: 'Analyzes requirements and creates implementation plans without writing code.',
    color: '#C3A6E0',
    systemPromptMode: 'prepend',
    systemPrompt:
      'You are a technical planner. Analyze the codebase and requirements, then produce a detailed implementation plan with specific files to create or modify, data flow descriptions, and a recommended build sequence. Do NOT write code — only plan.',
    disallowedTools: ['write_file', 'edit_file', 'execute'],
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  },
  {
    id: '__builtin__full-stack-dev',
    userId: '__system__',
    name: 'Full Stack Dev',
    description: 'General-purpose developer with all tools enabled and coding preferences loaded.',
    color: '#A8D5A2',
    systemPromptMode: 'prepend',
    systemPrompt:
      "You are a full-stack developer. Write clean, well-structured code following the project's existing conventions. Prefer small, focused changes. Run tests after modifications when possible.",
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  },
  {
    id: '__builtin__bug-fixer',
    userId: '__system__',
    name: 'Bug Fixer',
    description: 'Focused on diagnosing and fixing bugs with minimal, targeted changes.',
    color: '#F4A4A4',
    systemPromptMode: 'prepend',
    systemPrompt:
      'You are a bug fixer. Diagnose the root cause of the issue before making changes. Make minimal, targeted fixes — do not refactor surrounding code or add features. Verify the fix addresses the reported problem.',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  },
];
