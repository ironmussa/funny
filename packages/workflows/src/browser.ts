/**
 * Browser-safe workflow APIs.
 *
 * Keep this entrypoint free of filesystem-backed catalog exports so the client
 * can use schema, serialization, and graph helpers without bundling `node:fs`.
 */

export {
  workflowSchema,
  type ParsedWorkflow,
  type ParsedNode,
  type ParsedInputDef,
  type ParsedRetry,
  type ParsedLoop,
} from './schema.js';

export { parseWorkflowYaml, formatParseError, type ParseResult, type ParseError } from './parse.js';

export { serializeWorkflow, normalizeWorkflowForYaml } from './serialize.js';

export {
  workflowToGraph,
  graphToWorkflow,
  getWorkflowNodeAction,
  type WorkflowGraph,
  type WorkflowGraphNode,
  type WorkflowGraphEdge,
  type WorkflowGraphNodeData,
  type WorkflowGraphEdgeKind,
  type WorkflowGraphPosition,
} from './graph.js';
