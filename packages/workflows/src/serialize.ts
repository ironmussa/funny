import { stringify } from 'yaml';

import type { ParsedNode, ParsedWorkflow } from './schema.js';

type JsonObject = Record<string, unknown>;

export function normalizeWorkflowForYaml(workflow: ParsedWorkflow): JsonObject {
  const out: JsonObject = {
    name: workflow.name,
  };
  if (workflow.description) out.description = workflow.description;
  if (workflow.defaults) out.defaults = workflow.defaults;
  if (workflow.inputs) out.inputs = workflow.inputs;
  out.nodes = workflow.nodes.map(normalizeNodeForYaml);
  return out;
}

export function serializeWorkflow(workflow: ParsedWorkflow): string {
  return stringify(normalizeWorkflowForYaml(workflow), {
    aliasDuplicateObjects: false,
    lineWidth: 100,
  });
}

function normalizeNodeForYaml(node: ParsedNode): JsonObject {
  const out: JsonObject = { id: node.id };
  if (node.depends_on.length > 0) out.depends_on = node.depends_on;
  if (node.when) out.when = node.when;
  if (node.on_error !== 'fail') out.on_error = node.on_error;
  if (node.retry) out.retry = node.retry;
  if (node.loop) out.loop = node.loop;

  for (const key of ACTION_KEYS) {
    const value = node[key];
    if (value !== undefined) {
      out[key] = value;
      break;
    }
  }

  return out;
}

const ACTION_KEYS = [
  'spawn_agent',
  'run_command',
  'bash',
  'git_commit',
  'git_push',
  'create_pr',
  'notify',
  'set_status',
  'set_stage',
  'approval',
  'pipeline',
] as const;
