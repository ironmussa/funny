import type { EventModelData, ValidationIssue, AutomationDef, ReadModelDef } from './types.js';

/**
 * Validate an EventModel for consistency issues.
 * Returns all issues found (both errors and warnings).
 */
export function validate(model: EventModelData): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  checkReadModelSources(model, issues);
  checkAutomationReferences(model, issues);
  checkSequenceReferences(model, issues);
  checkSliceReferences(model, issues);
  checkOrphanElements(model, issues);
  checkDuplicateSequenceNames(model, issues);

  return issues;
}

/** ReadModel.from must reference existing events */
function checkReadModelSources(model: EventModelData, issues: ValidationIssue[]): void {
  for (const el of model.elements.values()) {
    if (el.kind !== 'readModel') continue;
    const rm = el as ReadModelDef;
    for (const source of rm.from) {
      const ref = model.elements.get(source);
      if (!ref) {
        issues.push({
          severity: 'error',
          code: 'READ_MODEL_UNKNOWN_SOURCE',
          message: `ReadModel "${rm.name}" references unknown event "${source}" in 'from'`,
          source: rm.name,
        });
      } else if (ref.kind !== 'event') {
        issues.push({
          severity: 'error',
          code: 'READ_MODEL_INVALID_SOURCE',
          message: `ReadModel "${rm.name}" references "${source}" which is a ${ref.kind}, not an event`,
          source: rm.name,
        });
      }
    }
  }
}

/** Automation.on must reference an event, automation.triggers must reference a command */
function checkAutomationReferences(model: EventModelData, issues: ValidationIssue[]): void {
  for (const el of model.elements.values()) {
    if (el.kind !== 'automation') continue;
    const auto = el as AutomationDef;

    // Check 'on' event
    const onRef = model.elements.get(auto.on);
    if (!onRef) {
      issues.push({
        severity: 'error',
        code: 'AUTOMATION_UNKNOWN_EVENT',
        message: `Automation "${auto.name}" listens to unknown event "${auto.on}"`,
        source: auto.name,
      });
    } else if (onRef.kind !== 'event') {
      issues.push({
        severity: 'error',
        code: 'AUTOMATION_INVALID_EVENT',
        message: `Automation "${auto.name}" listens to "${auto.on}" which is a ${onRef.kind}, not an event`,
        source: auto.name,
      });
    }

    // Check 'triggers' command(s)
    const triggers = Array.isArray(auto.triggers) ? auto.triggers : [auto.triggers];
    for (const t of triggers) {
      const tRef = model.elements.get(t);
      if (!tRef) {
        issues.push({
          severity: 'error',
          code: 'AUTOMATION_UNKNOWN_COMMAND',
          message: `Automation "${auto.name}" triggers unknown command "${t}"`,
          source: auto.name,
        });
      } else if (tRef.kind !== 'command') {
        issues.push({
          severity: 'warning',
          code: 'AUTOMATION_TRIGGERS_NON_COMMAND',
          message: `Automation "${auto.name}" triggers "${t}" which is a ${tRef.kind}, not a command`,
          source: auto.name,
        });
      }
    }
  }
}

/** Every name in a sequence must be a defined element */
function checkSequenceReferences(model: EventModelData, issues: ValidationIssue[]): void {
  for (const seq of model.sequences) {
    for (const step of seq.steps) {
      if (!model.elements.has(step)) {
        issues.push({
          severity: 'error',
          code: 'SEQUENCE_UNKNOWN_ELEMENT',
          message: `Sequence "${seq.name}" references unknown element "${step}"`,
          source: seq.name,
        });
      }
    }
  }
}

/** Every name in a slice must be a defined element */
function checkSliceReferences(model: EventModelData, issues: ValidationIssue[]): void {
  for (const slice of model.slices) {
    const allRefs = [...slice.commands, ...slice.events, ...slice.readModels, ...slice.automations];
    for (const ref of allRefs) {
      if (!model.elements.has(ref)) {
        issues.push({
          severity: 'error',
          code: 'SLICE_UNKNOWN_ELEMENT',
          message: `Slice "${slice.name}" references unknown element "${ref}"`,
          source: slice.name,
        });
      }
    }
  }
}

/** Warn about elements that never appear in any sequence */
function checkOrphanElements(model: EventModelData, issues: ValidationIssue[]): void {
  if (model.sequences.length === 0) return;

  const referenced = new Set<string>();
  for (const seq of model.sequences) {
    for (const step of seq.steps) {
      referenced.add(step);
    }
  }

  for (const el of model.elements.values()) {
    if (el.kind === 'readModel' || el.kind === 'automation') continue;
    if (!referenced.has(el.name)) {
      issues.push({
        severity: 'warning',
        code: el.kind === 'event' ? 'ORPHAN_EVENT' : 'ORPHAN_COMMAND',
        message: `${el.kind} "${el.name}" is defined but never appears in any sequence`,
        source: el.name,
      });
    }
  }
}

/** Warn about duplicate sequence names */
function checkDuplicateSequenceNames(model: EventModelData, issues: ValidationIssue[]): void {
  const seen = new Set<string>();
  for (const seq of model.sequences) {
    if (seen.has(seq.name)) {
      issues.push({
        severity: 'warning',
        code: 'DUPLICATE_SEQUENCE_NAME',
        message: `Duplicate sequence name "${seq.name}"`,
        source: seq.name,
      });
    }
    seen.add(seq.name);
  }
}
