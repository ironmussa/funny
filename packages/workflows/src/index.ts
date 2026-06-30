/**
 * @funny/workflows — versioned Funny workflow YAML.
 *
 * Owns the YAML schema, parser, serializer, built-in catalog, and graph
 * conversion used by the runtime and client. Execution remains in
 * @funny/pipelines plus runtime action providers.
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
  builtInWorkflowsDir,
  loadWorkflowCatalog,
  type WorkflowCatalogEntry,
  type WorkflowCatalogLoadOptions,
  type WorkflowCatalogLoadResult,
  type WorkflowSource,
} from './catalog.js';

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
