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

/** Discriminator for element kinds */
export type ElementKind = 'command' | 'event' | 'readModel' | 'automation';

// ── Element Definitions ─────────────────────────────────────

export interface CommandDef {
  kind: 'command';
  name: string;
  actor?: string;
  fields: FieldMap;
  description?: string;
}

export interface EventDef {
  kind: 'event';
  name: string;
  fields: FieldMap;
  description?: string;
}

export interface ReadModelDef {
  kind: 'readModel';
  name: string;
  from: string[];
  fields: FieldMap;
  description?: string;
}

export interface AutomationDef {
  kind: 'automation';
  name: string;
  on: string;
  triggers: string | string[];
  description?: string;
}

/** Union of all element definitions */
export type ElementDef = CommandDef | EventDef | ReadModelDef | AutomationDef;

// ── Options (input to fluent API) ───────────────────────────

export interface CommandOptions {
  actor?: string;
  fields: FieldMap;
  description?: string;
}

export interface EventOptions {
  fields: FieldMap;
  description?: string;
}

export interface ReadModelOptions {
  from: string[];
  fields: FieldMap;
  description?: string;
}

export interface AutomationOptions {
  on: string;
  triggers: string | string[];
  description?: string;
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
}

export interface SliceOptions {
  ui?: string;
  commands?: Array<ElementRef | string>;
  events?: Array<ElementRef | string>;
  readModels?: Array<ElementRef | string>;
  automations?: Array<ElementRef | string>;
}

// ── System Model ────────────────────────────────────────────

/** Complete snapshot of an EventModel for generators/validators */
export interface EventModelData {
  name: string;
  elements: Map<string, ElementDef>;
  sequences: SequenceDef[];
  slices: SliceDef[];
}

// ── Validation ──────────────────────────────────────────────

export type ValidationSeverity = 'error' | 'warning';

export interface ValidationIssue {
  severity: ValidationSeverity;
  code: string;
  message: string;
  source?: string;
}
