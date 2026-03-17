import { ok, err, type Result } from 'neverthrow';

import { parseFlow, parseStringSequence } from './flow.js';
import { generateAIPrompt } from './generators/ai-prompt.js';
import { generateJSON } from './generators/json.js';
import type {
  CommandDef,
  CommandOptions,
  EventDef,
  EventOptions,
  ReadModelDef,
  ReadModelOptions,
  AutomationDef,
  AutomationOptions,
  ElementRef,
  ElementDef,
  SequenceDef,
  SliceDef,
  SliceOptions,
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

function resolveRefs(arr: Array<ElementRef | string>): string[] {
  return arr.map((x) => (typeof x === 'string' ? x : x.name));
}

export class EventModel {
  readonly name: string;
  private _elements = new Map<string, ElementDef>();
  private _sequences: SequenceDef[] = [];
  private _slices: SliceDef[] = [];

  constructor(name: string) {
    this.name = name;
  }

  // ── Element Registration ─────────────────────────────────

  command(name: string, opts: CommandOptions): ElementRef {
    this._assertUnique(name);
    const def: CommandDef = { kind: 'command', name, ...opts };
    this._elements.set(name, def);
    return createRef(name, 'command');
  }

  event(name: string, opts: EventOptions): ElementRef {
    this._assertUnique(name);
    const def: EventDef = { kind: 'event', name, ...opts };
    this._elements.set(name, def);
    return createRef(name, 'event');
  }

  readModel(name: string, opts: ReadModelOptions): ElementRef {
    this._assertUnique(name);
    const def: ReadModelDef = { kind: 'readModel', name, ...opts };
    this._elements.set(name, def);
    return createRef(name, 'readModel');
  }

  automation(name: string, opts: AutomationOptions): ElementRef {
    this._assertUnique(name);
    const def: AutomationDef = { kind: 'automation', name, ...opts };
    this._elements.set(name, def);
    return createRef(name, 'automation');
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
    const parsed: string[] =
      typeof steps === 'string' ? parseStringSequence(steps) : steps.map((s) => s.name);
    this._sequences.push({ name, steps: parsed });
  }

  // ── Slices ───────────────────────────────────────────────

  slice(name: string, opts: SliceOptions): void {
    this._slices.push({
      name,
      ui: opts.ui,
      commands: resolveRefs(opts.commands ?? []),
      events: resolveRefs(opts.events ?? []),
      readModels: resolveRefs(opts.readModels ?? []),
      automations: resolveRefs(opts.automations ?? []),
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

  /** Get a snapshot of all data for external generators/validators */
  getData(): EventModelData {
    return {
      name: this.name,
      elements: new Map(this._elements),
      sequences: [...this._sequences],
      slices: [...this._slices],
    };
  }

  /** Get a specific element by name */
  getElement(name: string): ElementDef | undefined {
    return this._elements.get(name);
  }

  // ── Internals ────────────────────────────────────────────

  private _assertUnique(name: string): void {
    if (this._elements.has(name)) {
      throw new Error(`Element "${name}" is already defined in system "${this.name}"`);
    }
  }
}
