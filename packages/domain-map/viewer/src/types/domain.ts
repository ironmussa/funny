// Serialized graph types — mirrors @funny/domain-map but JSON-safe (no Map/Set)

export type SubdomainType = 'core' | 'supporting' | 'generic';
export type DomainLayer = 'domain' | 'application' | 'infrastructure';

export interface DomainNode {
  filePath: string;
  name: string;
  subdomain: string;
  subdomainType?: SubdomainType;
  context?: string;
  type: string;
  layer: DomainLayer;
  event?: string;
  emits: string[];
  consumes: string[];
  aggregate?: string;
  depends: string[];
}

export interface SubdomainDefinition {
  name: string;
  type: SubdomainType;
  description?: string;
  boundedContext: string;
  aggregates: string[];
  publishes: string[];
  exposes: string[];
}

export interface ContextRelationship {
  upstream: string;
  downstream: string;
  relationship: string;
  upstreamRole?: string;
  downstreamRole?: string;
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
  subdomains: Record<string, SubdomainDefinition>;
  sharedKernel?: { name: string; description?: string; includes: string[] };
  contextMap: ContextRelationship[];
  teams: TeamDefinition[];
}

export interface ValidationWarning {
  severity: 'warning' | 'error';
  code: string;
  message: string;
  source: 'yaml' | 'annotation' | 'cross';
}

/** JSON-serialized domain graph (from --format json) */
export interface SerializedGraph {
  nodes: Record<string, DomainNode>;
  subdomains: Record<string, string[]>;
  events: string[];
  strategic?: StrategicModel;
  warnings?: ValidationWarning[];
}

/** Event adjacency info */
export interface EventInfo {
  event: string;
  family: string;
  emitters: { name: string; subdomain: string }[];
  consumers: { name: string; subdomain: string }[];
  isCrossSubdomain: boolean;
  isOrphan: boolean;
  isDeadLetter: boolean;
}
