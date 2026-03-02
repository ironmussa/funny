export type {
  DomainAnnotation,
  DomainGraph,
  DomainType,
  DomainLayer,
  CLIOptions,
  // Strategic types
  RelationshipType,
  SubdomainDefinition,
  SharedKernelDefinition,
  ContextRelationship,
  TeamDefinition,
  StrategicModel,
  EnrichedDomainGraph,
  ValidationWarning,
  // Sync types
  SyncDirection,
  SyncAction,
} from './types.js';

export { parseFile, parseDirectory, buildGraph, buildEnrichedGraph } from './parser.js';
export { parseStrategicFile, parseStrategicYAML } from './strategic-parser.js';
export { validateConsistency } from './validator.js';
export { computeCodeToYamlActions, computeYamlToCodeActions } from './sync.js';
export { applyActionsToYAML } from './yaml-writer.js';
export { applyActionsToCode } from './code-writer.js';
export { generateMermaid, type MermaidOptions } from './generators/mermaid.js';
export { generateJSON } from './generators/json.js';
export { generateSequence, type SequenceOptions } from './generators/sequence.js';
export { generateCatalog, type CatalogOptions } from './generators/catalog.js';
export { generateContextMap, type ContextMapOptions } from './generators/context-map.js';
export { generateInventory, type InventoryOptions } from './generators/inventory.js';
export { generateExplorer, type ExplorerOptions } from './generators/explorer.js';
export {
  buildEventAdjacency,
  groupEventsByFamily,
  type EventInfo,
} from './generators/event-utils.js';
