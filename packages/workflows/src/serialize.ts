import { stringify } from 'yaml';

import { ACTION_KEYS, type ParsedNode, type ParsedWorkflow } from './schema.js';

/** A workflow as written to YAML: its set fields only, with each node normalized. */
type WorkflowYaml = Pick<ParsedWorkflow, 'name'> &
  Partial<Pick<ParsedWorkflow, 'description' | 'defaults' | 'inputs'>> & {
    nodes?: NodeYaml[];
  };

/** A node as written to YAML: its id, the fields that differ from the defaults, and its action. */
type NodeYaml = Pick<ParsedNode, 'id'> & Partial<Omit<ParsedNode, 'id'>>;

export function normalizeWorkflowForYaml(workflow: ParsedWorkflow): WorkflowYaml {
  const out: WorkflowYaml = {
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

function normalizeNodeForYaml(node: ParsedNode): NodeYaml {
  const out: NodeYaml = { id: node.id };
  if (node.depends_on.length > 0) out.depends_on = node.depends_on;
  if (node.trigger_rule) out.trigger_rule = node.trigger_rule;
  if (node.concurrency) out.concurrency = node.concurrency;
  if (node.when) out.when = node.when;
  if (node.on_error !== 'fail') out.on_error = node.on_error;
  if (node.retry) out.retry = node.retry;
  if (node.loop) out.loop = node.loop;

  for (const key of ACTION_KEYS) {
    const value = node[key];
    if (value !== undefined) {
      Object.assign(out, { [key]: value });
      break;
    }
  }

  return out;
}
