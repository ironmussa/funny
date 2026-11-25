import type { AgentProvider, McpServer } from '@funny/shared';
import { errorMessage } from '@funny/shared/errors';

import { log } from '../../lib/logger.js';
import { isObject, isString } from '../../lib/value-guards.js';
import type { RuntimeThreadRecord } from '../server-interfaces.js';
import type { AgentMcpServers } from './load-mcp-servers.js';

export interface AgentTemplateResolution {
  disallowedTools?: string[];
  mcpServers?: AgentMcpServers;
  systemPrompt?: string;
  builtinSkillsDisabled?: string[];
  customSkillPaths?: string[];
  agentName?: string;
}

interface ResolveAgentTemplateInput {
  threadId: string;
  thread: RuntimeThreadRecord | undefined;
  provider: AgentProvider;
  disallowedTools?: string[];
  mcpServers?: AgentMcpServers;
}

/** A template's list column: JSON text from the database, or a list already parsed. */
type StoredListColumn = string | readonly unknown[] | null | undefined;

/** A thread's template variables: JSON text from the database, or an object already parsed. */
type StoredTemplateVariables = string | Readonly<Record<string, string>> | null | undefined;

/** Parse JSON text columns that may already be parsed. */
function parseJsonCol<T>(val: StoredListColumn): T[] {
  return val ? ((isString(val) ? JSON.parse(val) : val) as T[]) : [];
}

function parseTemplateVariables(rawVars: StoredTemplateVariables): Record<string, string> {
  if (isString(rawVars)) return JSON.parse(rawVars);
  return isObject(rawVars) ? (rawVars as Record<string, string>) : {};
}

/** Replace `{{VAR_NAME}}` placeholders with the thread's template variables. */
function interpolateTemplatePrompt(prompt: string, rawVars: StoredTemplateVariables): string {
  const varValues = parseTemplateVariables(rawVars);
  if (Object.keys(varValues).length === 0) return prompt;
  return prompt.replace(
    /\{\{(\w+)\}\}/g,
    (match: string, name: string) => varValues[name] ?? match,
  );
}

async function loadAgentTemplate(templateId: string): Promise<any> {
  // Check builtin templates first (no remote call needed)
  const { BUILTIN_AGENT_TEMPLATES } = await import('@funny/shared');
  const builtinTpl = BUILTIN_AGENT_TEMPLATES.find((t: { id: string }) => t.id === templateId);
  const { remoteGetAgentTemplate } = await import('../remote-thread-data-client.js');
  return builtinTpl ?? (await remoteGetAgentTemplate(templateId));
}

/**
 * Apply a template's fields onto `out`. Mutates progressively so a failure
 * midway (e.g. malformed JSON) keeps whatever was already merged — matching
 * the original inline behavior.
 */
function applyTemplate(
  out: AgentTemplateResolution,
  tpl: any,
  threadId: string,
  templateVariables: StoredTemplateVariables,
): void {
  const tplDisallowed = parseJsonCol<string>(tpl.disallowedTools);
  const tplMcpServers = parseJsonCol<McpServer>(tpl.mcpServers);
  mergeTemplateDisallowedTools(out, tplDisallowed);
  mergeTemplateMcpServers(out, tplMcpServers);

  // Template system prompt (prepend/append are handled in systemPrefix assembly)
  if (tpl.systemPrompt) {
    out.systemPrompt = interpolateTemplatePrompt(tpl.systemPrompt, templateVariables);
  }

  // Phase 2: Parse remaining template fields for runtime wiring
  out.builtinSkillsDisabled = parseJsonCol<string>(tpl.builtinSkillsDisabled);
  const customSkillPaths = parseJsonCol<string>(tpl.customSkillPaths);
  out.customSkillPaths = customSkillPaths;
  out.agentName = tpl.agentName ?? undefined;

  log.info('Agent template resolved', {
    namespace: 'agent',
    threadId,
    templateId: tpl.id,
    templateName: tpl.name,
    systemPromptMode: tpl.systemPromptMode,
    disallowedToolsCount: tplDisallowed.length,
    mcpServersCount: tplMcpServers.length,
    builtinSkillsDisabled: out.builtinSkillsDisabled,
    customSkillPaths: customSkillPaths.length,
    agentName: out.agentName,
  });
}

/** Merge template disallowed tools. */
function mergeTemplateDisallowedTools(out: AgentTemplateResolution, tplDisallowed: string[]): void {
  if (tplDisallowed.length > 0) {
    out.disallowedTools = [...(out.disallowedTools ?? []), ...tplDisallowed];
  }
}

/** Merge template MCP servers (additive). */
function mergeTemplateMcpServers(out: AgentTemplateResolution, tplMcpServers: McpServer[]): void {
  if (tplMcpServers.length === 0) return;
  const merged: AgentMcpServers = { ...(out.mcpServers ?? {}) };
  out.mcpServers = merged;
  for (const srv of tplMcpServers) {
    merged[srv.name] = srv;
  }
}

/**
 * Resolve the agent template (Deep Agent only) and merge its tools, MCP
 * servers and runtime fields into the start options. Failures are logged and
 * never block the agent start.
 */
export async function resolveAgentTemplate(
  input: ResolveAgentTemplateInput,
): Promise<AgentTemplateResolution> {
  const out: AgentTemplateResolution = {
    disallowedTools: input.disallowedTools,
    mcpServers: input.mcpServers,
  };
  const { thread } = input;
  if (!thread?.agentTemplateId || input.provider !== 'deepagent') return out;

  try {
    const tpl = await loadAgentTemplate(thread.agentTemplateId);
    if (tpl) applyTemplate(out, tpl, input.threadId, thread.templateVariables);
  } catch (err) {
    log.warn('Failed to resolve agent template', {
      namespace: 'agent',
      threadId: input.threadId,
      templateId: thread.agentTemplateId,
      error: errorMessage(err),
    });
  }
  return out;
}
