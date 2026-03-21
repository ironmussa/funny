/** Primitive field types supported by the DSL */
export type FieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'decimal'
  | 'datetime'
  | 'date'
  | 'uuid'
  | (string & {}); // allows "CartItem[]", "string?", custom types

/** A map of field names to their types */
export type FieldMap = Record<string, FieldType>;

/** Reference to implementation source code */
export interface SourceRef {
  /** Relative file path to the source file */
  file: string;
  /** Optional exported function/class/handler name */
  exportName?: string;
  /** Optional 1-based start line number */
  startLine?: number;
  /** Optional 1-based end line number */
  endLine?: number;
  /** Pre-embedded source content (used when viewer has no filesystem access) */
  content?: string;
  /** Language hint for syntax highlighting (inferred from file extension if omitted) */
  language?: string;
}

/** Discriminator for element kinds */
export type ElementKind =
  | 'command'
  | 'event'
  | 'readModel'
  | 'automation'
  | 'aggregate'
  | 'screen'
  | 'external'
  | 'saga';

// ── Element Definitions ─────────────────────────────────────

export interface CommandDef {
  kind: 'command';
  name: string;
  actor?: string;
  fields: FieldMap;
  description?: string;
  version?: number;
  source?: SourceRef;
}

export interface EventDef {
  kind: 'event';
  name: string;
  fields: FieldMap;
  description?: string;
  version?: number;
  source?: SourceRef;
}

export interface ReadModelDef {
  kind: 'readModel';
  name: string;
  from: string[];
  fields: FieldMap;
  description?: string;
  source?: SourceRef;
}

export interface AutomationDef {
  kind: 'automation';
  name: string;
  on: string;
  triggers: string | string[];
  description?: string;
  source?: SourceRef;
}

export interface AggregateDef {
  kind: 'aggregate';
  name: string;
  handles: string[];
  emits: string[];
  invariants: string[];
  description?: string;
  source?: SourceRef;
}

export interface ScreenDef {
  kind: 'screen';
  name: string;
  displays: string[];
  triggers: string[];
  description?: string;
  source?: SourceRef;
}

export interface ExternalDef {
  kind: 'external';
  name: string;
  receives: string[];
  emits: string[];
  description?: string;
  source?: SourceRef;
}

export interface SagaDef {
  kind: 'saga';
  name: string;
  on: string[];
  correlationKey: string;
  when: string;
  triggers: string | string[];
  description?: string;
  source?: SourceRef;
}

/** Union of all element definitions */
export type ElementDef =
  | CommandDef
  | EventDef
  | ReadModelDef
  | AutomationDef
  | AggregateDef
  | ScreenDef
  | ExternalDef
  | SagaDef;

// ── Options (input to fluent API) ───────────────────────────

export interface CommandOptions {
  actor?: string;
  fields: FieldMap;
  description?: string;
  version?: number;
  source?: SourceRef;
}

export interface EventOptions {
  fields: FieldMap;
  description?: string;
  version?: number;
  source?: SourceRef;
}

export interface ReadModelOptions {
  from: Array<ElementRef | string>;
  fields: FieldMap;
  description?: string;
  source?: SourceRef;
}

export interface AutomationOptions {
  on: string;
  triggers: string | string[];
  description?: string;
  source?: SourceRef;
}

export interface AggregateOptions {
  handles: Array<ElementRef | string>;
  emits: Array<ElementRef | string>;
  invariants?: string[];
  description?: string;
  source?: SourceRef;
}

export interface ScreenOptions {
  displays: Array<ElementRef | string>;
  triggers: Array<ElementRef | string>;
  description?: string;
  source?: SourceRef;
}

export interface ExternalOptions {
  receives?: Array<ElementRef | string>;
  emits?: Array<ElementRef | string>;
  description?: string;
  source?: SourceRef;
}

export interface SagaOptions {
  on: Array<ElementRef | string>;
  correlationKey: string;
  when: string;
  triggers: string | Array<ElementRef | string>;
  description?: string;
  source?: SourceRef;
}

// ── Element Reference ───────────────────────────────────────

/**
 * Lightweight handle returned by system.command(), system.event(), etc.
 * toString() returns the name so it works in tagged template literal
 * interpolation: flow`${AddItemToCart} -> ${ItemAddedToCart}`
 */
export interface ElementRef {
  readonly name: string;
  readonly kind: ElementKind;
  toString(): string;
}

// ── Sequences ───────────────────────────────────────────────

/** A single step in a sequence */
export interface SequenceStep {
  name: string;
  kind: ElementKind;
}

/** A named sequence of steps representing a temporal flow */
export interface SequenceDef {
  name: string;
  steps: string[];
}

// ── Slices ──────────────────────────────────────────────────

export interface SliceDef {
  name: string;
  ui?: string;
  commands: string[];
  events: string[];
  readModels: string[];
  automations: string[];
  aggregates: string[];
  screens: string[];
  externals: string[];
  sagas: string[];
}

export interface SliceOptions {
  ui?: string;
  commands?: Array<ElementRef | string>;
  events?: Array<ElementRef | string>;
  readModels?: Array<ElementRef | string>;
  automations?: Array<ElementRef | string>;
  aggregates?: Array<ElementRef | string>;
  screens?: Array<ElementRef | string>;
  externals?: Array<ElementRef | string>;
  sagas?: Array<ElementRef | string>;
}

// ── Bounded Contexts ────────────────────────────────────────

export interface ContextDef {
  name: string;
  elements: string[];
}

// ── System Model ────────────────────────────────────────────

/** Complete snapshot of an EventModel for generators/validators */
export interface EventModelData {
  name: string;
  elements: Map<string, ElementDef>;
  sequences: SequenceDef[];
  slices: SliceDef[];
  contexts: ContextDef[];
}

// ── Validation ──────────────────────────────────────────────

export type ValidationSeverity = 'error' | 'warning';

export interface ValidationIssue {
  severity: ValidationSeverity;
  code: string;
  message: string;
  source?: string;
}
