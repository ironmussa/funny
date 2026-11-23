/**
 * @funny/workflows — versioned Funny workflow YAML.
 *
 * Owns the YAML schema, parser, serializer, built-in catalog, and graph
 * conversion used by the runtime and client. Execution remains in
 * @funny/pipelines plus runtime action providers.
 */

export {
  workflowSchema,
  isProofReady,
  type ParsedWorkflow,
  type ParsedNode,
  type ParsedInputDef,
  type ParsedRetry,
  type ParsedLoop,
  type ParsedConcurrency,
  type ParsedRegressionProofRule,
  type TriggerRuleName,
  TRIGGER_RULES,
} from './schema.js';

export {
  parseWorkflowYaml,
  formatParseError,
  type ParseResult,
  type ParseError,
  type ParseOptions,
  type WorkflowIssue,
} from './parse.js';

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

export {
  resolvePromptFiles,
  normalizePromptPath,
  listAgentSteps,
  type FlowAgentStep,
  type PromptFileReader,
  type PromptFileProblem,
  type PromptFilesResult,
} from './prompt-files.js';

export {
  INTEGRATE_CONFIG_PATH,
  EMPTY_INTEGRATE_CONFIG,
  parseIntegrateConfig,
  type IntegrateConfig,
  type IntegrateConfigProblem,
  type IntegrateConfigResult,
  type IntegrateRegenerator,
} from './integrate-config.js';
