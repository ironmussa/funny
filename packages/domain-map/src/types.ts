// ── DDD Concept Types ────────────────────────────────────────────

export type DomainType =
  // ── DDD Strategic ───────────────────────────────────
  | 'bounded-context'
  | 'anti-corruption-layer'
  | 'published-language'
  | 'context-map'
  // ── DDD Tactical ────────────────────────────────────
  | 'aggregate-root'
  | 'entity'
  | 'value-object'
  | 'domain-event'
  | 'domain-service'
  | 'app-service'
  | 'repository'
  | 'factory'
  | 'specification'
  | 'policy'
  | 'module'
  // ── Architectural ───────────────────────────────────
  | 'port'
  | 'adapter'
  | 'event-bus'
  | 'handler';

export type DomainLayer = 'domain' | 'application' | 'infrastructure';

export type SubdomainType = 'core' | 'supporting' | 'generic';

// ── Single annotation block ──────────────────────────────────────

export interface DomainAnnotation {
  /** Absolute or relative file path */
  filePath: string;

  /** Name of the annotated export (class, interface, const, etc.).
   *  Falls back to filename stem for file-level annotations. */
  name: string;

  /** Subdomain name (e.g., "Git Operations", "Thread Management") */
  subdomain: string;

  /** Strategic subdomain classification */
  subdomainType?: SubdomainType;

  /** Bounded Context (the technical boundary, e.g., "Server", "Client") */
  context?: string;

  /** DDD concept type */
  type: DomainType;

  /** Architectural layer */
  layer: DomainLayer;

  /** For domain-event types: the event this interface defines */
  event?: string;

  /** Events this component emits */
  emits: string[];

  /** Events this component consumes */
  consumes: string[];

  /** Parent aggregate root name */
  aggregate?: string;

  /** Dependencies (other domain components) */
  depends: string[];
}

// ── Graph built from all annotations ─────────────────────────────

export interface DomainGraph {
  /** All parsed annotations, keyed by `${subdomain}::${name}` */
  nodes: Map<string, DomainAnnotation>;

  /** Subdomains discovered, with their member node keys */
  subdomains: Map<string, string[]>;

  /** All unique event names found across emits/consumes/event tags */
  events: Set<string>;
}

// ── Strategic DDD Types ─────────────────────────────────────────

export type RelationshipType =
  | 'customer-supplier'
  | 'partnership'
  | 'conformist'
  | 'published-language'
  | 'anti-corruption-layer'
  | 'open-host-service'
  | 'shared-kernel'
  | 'separate-ways';

export interface SubdomainDefinition {
  name: string;
  type: SubdomainType;
  description?: string;
  boundedContext: string;
  aggregates: string[];
  publishes: string[];
  exposes: string[];
}

export interface SharedKernelDefinition {
  name: string;
  description?: string;
  includes: string[];
}

export interface ContextRelationship {
  upstream: string;
  downstream: string;
  relationship: RelationshipType;
  upstreamRole?: 'supplier' | 'customer';
  downstreamRole?: 'supplier' | 'customer';
  via?: string;
  description?: string;
  implementedBy?: string[];
}

export interface TeamDefinition {
  name: string;
  description?: string;
  owns: string[];
  contact?: string;
}

export interface StrategicModel {
  domain: { name: string; description?: string };
  subdomains: Map<string, SubdomainDefinition>;
  sharedKernel?: SharedKernelDefinition;
  contextMap: ContextRelationship[];
  teams: TeamDefinition[];
}

// ── Enriched graph (tactical + strategic) ───────────────────────

export interface EnrichedDomainGraph extends DomainGraph {
  strategic?: StrategicModel;
}

// ── Validation ──────────────────────────────────────────────────

export interface ValidationWarning {
  severity: 'warning' | 'error';
  code: string;
  message: string;
  source: 'yaml' | 'annotation' | 'cross';
}

// ── Sync Types ──────────────────────────────────────────────────

export type SyncDirection = 'code-to-yaml' | 'yaml-to-code';

export interface SyncAction {
  direction: SyncDirection;
  kind:
    | 'add-subdomain'
    | 'add-events'
    | 'add-context-map'
    | 'update-subdomain-type'
    | 'add-context'
    | 'notify-unannotated';
  message: string;
  /** For code-to-yaml: YAML section path. For yaml-to-code: file path. */
  target: string;
  payload: Record<string, unknown>;
}

// ── CLI options ──────────────────────────────────────────────────

export interface CLIOptions {
  /** Source directory to scan (default: cwd) */
  dir: string;

  /** Output file path (default: stdout) */
  output?: string;

  /** Filter: only show nodes in these subdomains */
  filterSubdomain?: string[];

  /** Filter: only show nodes of these types */
  filterType?: DomainType[];

  /** Output format */
  format: 'mermaid' | 'json' | 'sequence' | 'catalog' | 'context-map' | 'inventory' | 'explorer';

  /** Show event flow only (suppress dependency arrows) */
  eventsOnly: boolean;

  /** Mermaid diagram direction */
  direction: 'LR' | 'TB';

  /** Event family prefix filter for sequence diagrams (e.g., 'agent', 'git') */
  scenario?: string;

  /** Show ThreadEventBus as explicit mediator in sequence diagrams */
  showBus?: boolean;

  /** Path to strategic domain.yaml file */
  domainFile?: string;

  /** Run cross-validation between YAML and annotations */
  validate?: boolean;

  /** Sync direction: code-to-yaml or yaml-to-code */
  sync?: SyncDirection;

  /** Write sync changes to files (default: dry-run) */
  write?: boolean;
}
