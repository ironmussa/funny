import { ok, err, type Result } from 'neverthrow';

import { parseFlow, parseStringSequence } from './flow.js';
import { generateAIPrompt } from './generators/ai-prompt.js';
import { generateJSON } from './generators/json.js';
import { generateMermaid, type MermaidOptions } from './generators/mermaid.js';
import {
  generateReactFlowGraph,
  type ReactFlowOptions,
  type ReactFlowGraph,
} from './generators/react-flow.js';
import type {
  CommandDef,
  CommandOptions,
  EventDef,
  EventOptions,
  ReadModelDef,
  ReadModelOptions,
  AutomationDef,
  AutomationOptions,
  AggregateDef,
  AggregateOptions,
  ScreenDef,
  ScreenOptions,
  ExternalDef,
  ExternalOptions,
  SagaDef,
  SagaOptions,
  ElementRef,
  ElementDef,
  SequenceDef,
  SliceDef,
  SliceOptions,
  ContextDef,
  EventModelData,
  ValidationIssue,
  ElementKind,
  SequenceStep,
} from './types.js';
import { validate } from './validator.js';

function createRef(name: string, kind: ElementKind): ElementRef {
  return {
    name,
    kind,
    toString() {
      return name;
    },
  };
}

function isString<T>(value: T): value is T & string {
  return typeof value === 'string';
}

function resolveRefs(arr: Array<ElementRef | string>): string[] {
  return arr.map((x) => (isString(x) ? x : x.name));
}

/** Public API surface available inside context() callbacks */
export type ContextBuilder = Pick<
  EventModel,
  'command' | 'event' | 'readModel' | 'automation' | 'aggregate' | 'screen' | 'external' | 'saga'
>;

export class EventModel {
  readonly name: string;
  #elements = new Map<string, ElementDef>();
  #sequences: SequenceDef[] = [];
  #slices: SliceDef[] = [];
  #contexts: ContextDef[] = [];

  constructor(name: string) {
    this.name = name;
  }

  // ── Element Registration ─────────────────────────────────

  command(name: string, opts: CommandOptions): ElementRef {
    this.#assertUnique(name);
    const def: CommandDef = { kind: 'command', name, ...opts };
    this.#elements.set(name, def);
    return createRef(name, 'command');
  }

  event(name: string, opts: EventOptions): ElementRef {
    this.#assertUnique(name);
    const def: EventDef = { kind: 'event', name, ...opts };
    this.#elements.set(name, def);
    return createRef(name, 'event');
  }

  readModel(name: string, opts: ReadModelOptions): ElementRef {
    this.#assertUnique(name);
    const def: ReadModelDef = {
      kind: 'readModel',
      name,
      from: resolveRefs(opts.from),
      fields: opts.fields,
      description: opts.description,
      source: opts.source,
    };
    this.#elements.set(name, def);
    return createRef(name, 'readModel');
  }

  automation(name: string, opts: AutomationOptions): ElementRef {
    this.#assertUnique(name);
    const def: AutomationDef = { kind: 'automation', name, ...opts };
    this.#elements.set(name, def);
    return createRef(name, 'automation');
  }

  aggregate(name: string, opts: AggregateOptions): ElementRef {
    this.#assertUnique(name);
    const def: AggregateDef = {
      kind: 'aggregate',
      name,
      handles: resolveRefs(opts.handles),
      emits: resolveRefs(opts.emits),
      invariants: opts.invariants ?? [],
      description: opts.description,
      source: opts.source,
    };
    this.#elements.set(name, def);
    return createRef(name, 'aggregate');
  }

  screen(name: string, opts: ScreenOptions): ElementRef {
    this.#assertUnique(name);
    const def: ScreenDef = {
      kind: 'screen',
      name,
      displays: resolveRefs(opts.displays),
      triggers: resolveRefs(opts.triggers),
      description: opts.description,
      source: opts.source,
    };
    this.#elements.set(name, def);
    return createRef(name, 'screen');
  }

  external(name: string, opts: ExternalOptions): ElementRef {
    this.#assertUnique(name);
    const def: ExternalDef = {
      kind: 'external',
      name,
      receives: resolveRefs(opts.receives ?? []),
      emits: resolveRefs(opts.emits ?? []),
      description: opts.description,
      source: opts.source,
    };
    this.#elements.set(name, def);
    return createRef(name, 'external');
  }

  saga(name: string, opts: SagaOptions): ElementRef {
    this.#assertUnique(name);
    const triggers = Array.isArray(opts.triggers) ? resolveRefs(opts.triggers) : opts.triggers;
    const def: SagaDef = {
      kind: 'saga',
      name,
      on: resolveRefs(opts.on),
      correlationKey: opts.correlationKey,
      when: opts.when,
      triggers,
      description: opts.description,
      source: opts.source,
    };
    this.#elements.set(name, def);
    return createRef(name, 'saga');
  }

  // ── Bounded Contexts ───────────────────────────────────────

  /**
   * Group elements into a bounded context.
   * Elements defined inside the callback are tracked as belonging to this context.
   */
  context(name: string, fn: (ctx: ContextBuilder) => void): void {
    const elementsBefore = new Set(this.#elements.keys());
    fn(this);
    const elementsAfter = new Set(this.#elements.keys());
    const newElements = [...elementsAfter].filter((e) => !elementsBefore.has(e));
    this.#contexts.push({ name, elements: newElements });
  }

  // ── Tagged Template Literal ──────────────────────────────

  /**
   * Tagged template literal for defining sequences.
   * Arrow function so it works with destructuring: const { flow } = system
   *
   * Usage:
   *   const { flow } = system;
   *   system.sequence("Happy Path", flow`${AddItem} -> ${ItemAdded}`)
   */
  flow = (strings: TemplateStringsArray, ...values: ElementRef[]): SequenceStep[] => {
    return parseFlow(strings, values);
  };

  // ── Sequences ────────────────────────────────────────────

  /**
   * Register a named sequence.
   * Accepts either:
   *   - SequenceStep[] from the flow`` tagged template
   *   - A plain string like "A -> B -> C"
   */
  sequence(name: string, steps: SequenceStep[] | string): void {
    const parsed: string[] = isString(steps)
      ? parseStringSequence(steps)
      : steps.map((s) => s.name);
    this.#sequences.push({ name, steps: parsed });
  }

  // ── Slices ───────────────────────────────────────────────

  slice(name: string, opts: SliceOptions): void {
    this.#slices.push({
      name,
      ui: opts.ui,
      commands: resolveRefs(opts.commands ?? []),
      events: resolveRefs(opts.events ?? []),
      readModels: resolveRefs(opts.readModels ?? []),
      automations: resolveRefs(opts.automations ?? []),
      aggregates: resolveRefs(opts.aggregates ?? []),
      screens: resolveRefs(opts.screens ?? []),
      externals: resolveRefs(opts.externals ?? []),
      sagas: resolveRefs(opts.sagas ?? []),
    });
  }

  // ── Output ───────────────────────────────────────────────

  /** Validate the model. ok() may contain warnings, err() means errors exist. */
  validate(): Result<ValidationIssue[], ValidationIssue[]> {
    const issues = validate(this.getData());
    const errors = issues.filter((i) => i.severity === 'error');
    return errors.length > 0 ? err(issues) : ok(issues);
  }

  /** Export as formatted JSON string */
  toJSON(): string {
    return generateJSON(this.getData());
  }

  /** Export as structured AI prompt (markdown) */
  toAIPrompt(): string {
    return generateAIPrompt(this.getData());
  }

  /** Export as Mermaid diagram (flowchart or sequence) */
  toMermaid(options?: MermaidOptions): string {
    return generateMermaid(this.getData(), options);
  }

  /** Export as React Flow nodes & edges for interactive visualization */
  toReactFlowGraph(options?: ReactFlowOptions): ReactFlowGraph {
    return generateReactFlowGraph(this.getData(), options);
  }

  /** Get a snapshot of all data for external generators/validators */
  getData(): EventModelData {
    return {
      name: this.name,
      elements: new Map(this.#elements),
      sequences: [...this.#sequences],
      slices: [...this.#slices],
      contexts: [...this.#contexts],
    };
  }

  /** Get a specific element by name */
  getElement(name: string): ElementDef | undefined {
    return this.#elements.get(name);
  }

  // ── Internals ────────────────────────────────────────────

  #assertUnique(name: string): void {
    if (this.#elements.has(name)) {
      throw new Error(`Element "${name}" is already defined in system "${this.name}"`);
    }
  }
}
