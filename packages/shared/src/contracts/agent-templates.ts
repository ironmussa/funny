/**
 * `/api/agent-templates` input schemas (served over tRPC, `@funny/api`
 * `agentTemplates` router, and by the REST routes). The list fields are stored
 * as JSON and accepted as the REST route always accepted them.
 */

import { z } from 'zod';

export const agentTemplateBody = z.object({
  name: z.string().min(1, 'Missing required field: name'),
  description: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  systemPromptMode: z.string().optional(),
  systemPrompt: z.string().nullable().optional(),
  disallowedTools: z.unknown().optional(),
  mcpServers: z.unknown().optional(),
  builtinSkillsDisabled: z.unknown().optional(),
  customSkillPaths: z.unknown().optional(),
  agentName: z.string().nullable().optional(),
  shared: z.boolean().optional(),
  variables: z.unknown().optional(),
});

export const updateAgentTemplateBody = agentTemplateBody.partial();

export type AgentTemplateBody = z.output<typeof agentTemplateBody>;
export type UpdateAgentTemplateBody = z.output<typeof updateAgentTemplateBody>;
