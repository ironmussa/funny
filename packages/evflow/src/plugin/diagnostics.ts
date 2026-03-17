import type ts from 'typescript/lib/tsserverlibrary';

import {
  isEvflowMethodCall,
  getMethodName,
  getOptionsArg,
  getStringProperty,
  getStringOrArrayProperty,
  getProperty,
  getStringArrayElements,
  parseSequenceString,
} from './ast-utils.js';
import type { RegisteredElement } from './registry.js';

const EVFLOW_ERROR_BASE = 20000;

/**
 * Produce evflow-specific diagnostics for a source file.
 *
 * Validates that string references in readModel.from, automation.on,
 * automation.triggers, sequence strings, and slice arrays point to
 * elements that actually exist in the registry.
 */
export function getEvflowDiagnostics(
  ts: typeof import('typescript/lib/tsserverlibrary'),
  sourceFile: ts.SourceFile,
  registry: Map<string, RegisteredElement>,
): ts.Diagnostic[] {
  const diagnostics: ts.Diagnostic[] = [];

  function visit(node: ts.Node): void {
    if (!isEvflowMethodCall(ts, node)) {
      ts.forEachChild(node, visit);
      return;
    }

    const call = node as ts.CallExpression;
    const method = getMethodName(ts, call);
    if (!method) {
      ts.forEachChild(node, visit);
      return;
    }

    switch (method) {
      case 'readModel':
        checkReadModel(ts, call, sourceFile, registry, diagnostics);
        break;
      case 'automation':
        checkAutomation(ts, call, sourceFile, registry, diagnostics);
        break;
      case 'sequence':
        checkSequence(ts, call, sourceFile, registry, diagnostics);
        break;
      case 'slice':
        checkSlice(ts, call, sourceFile, registry, diagnostics);
        break;
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return diagnostics;
}

/** Validate readModel({ from: ['EventName'] }) */
function checkReadModel(
  ts: typeof import('typescript/lib/tsserverlibrary'),
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  registry: Map<string, RegisteredElement>,
  diagnostics: ts.Diagnostic[],
): void {
  const opts = getOptionsArg(ts, call);
  if (!opts) return;

  const fromProp = getProperty(ts, opts, 'from');
  if (!fromProp) return;

  const fromStrings = getStringArrayElements(ts, fromProp.initializer);
  for (const str of fromStrings) {
    const el = registry.get(str.text);
    if (!el) {
      diagnostics.push(
        makeDiag(ts, sourceFile, str, `Unknown event "${str.text}"`, ts.DiagnosticCategory.Error),
      );
    } else if (el.kind !== 'event') {
      diagnostics.push(
        makeDiag(
          ts,
          sourceFile,
          str,
          `"${str.text}" is a ${el.kind}, expected an event`,
          ts.DiagnosticCategory.Error,
        ),
      );
    }
  }
}

/** Validate automation({ on: 'EventName', triggers: 'CommandName' }) */
function checkAutomation(
  ts: typeof import('typescript/lib/tsserverlibrary'),
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  registry: Map<string, RegisteredElement>,
  diagnostics: ts.Diagnostic[],
): void {
  const opts = getOptionsArg(ts, call);
  if (!opts) return;

  // Check 'on' — must be an existing event
  const onStr = getStringProperty(ts, opts, 'on');
  if (onStr) {
    const el = registry.get(onStr.text);
    if (!el) {
      diagnostics.push(
        makeDiag(
          ts,
          sourceFile,
          onStr,
          `Unknown event "${onStr.text}"`,
          ts.DiagnosticCategory.Error,
        ),
      );
    } else if (el.kind !== 'event') {
      diagnostics.push(
        makeDiag(
          ts,
          sourceFile,
          onStr,
          `"${onStr.text}" is a ${el.kind}, expected an event`,
          ts.DiagnosticCategory.Error,
        ),
      );
    }
  }

  // Check 'triggers' — must be existing command(s)
  const triggersStrings = getStringOrArrayProperty(ts, opts, 'triggers');
  for (const str of triggersStrings) {
    const el = registry.get(str.text);
    if (!el) {
      diagnostics.push(
        makeDiag(ts, sourceFile, str, `Unknown command "${str.text}"`, ts.DiagnosticCategory.Error),
      );
    } else if (el.kind !== 'command') {
      diagnostics.push(
        makeDiag(
          ts,
          sourceFile,
          str,
          `"${str.text}" is a ${el.kind}, expected a command`,
          ts.DiagnosticCategory.Warning,
        ),
      );
    }
  }
}

/** Validate sequence('name', 'A -> B -> C') */
function checkSequence(
  ts: typeof import('typescript/lib/tsserverlibrary'),
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  registry: Map<string, RegisteredElement>,
  diagnostics: ts.Diagnostic[],
): void {
  const secondArg = call.arguments[1];
  if (!secondArg || !ts.isStringLiteral(secondArg)) return;

  const steps = parseSequenceString(secondArg.text, secondArg.getStart(sourceFile));
  for (const step of steps) {
    if (!registry.has(step.name)) {
      diagnostics.push({
        file: sourceFile,
        start: step.start,
        length: step.length,
        messageText: `Unknown element "${step.name}" in sequence`,
        category: ts.DiagnosticCategory.Error,
        code: EVFLOW_ERROR_BASE + 4,
        source: 'evflow',
      });
    }
  }
}

/** Validate slice({ commands: ['X'], events: ['Y'], ... }) */
function checkSlice(
  ts: typeof import('typescript/lib/tsserverlibrary'),
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  registry: Map<string, RegisteredElement>,
  diagnostics: ts.Diagnostic[],
): void {
  const opts = getOptionsArg(ts, call);
  if (!opts) return;

  const checks: Array<{ prop: string; expectedKind?: string }> = [
    { prop: 'commands', expectedKind: 'command' },
    { prop: 'events', expectedKind: 'event' },
    { prop: 'readModels', expectedKind: 'readModel' },
    { prop: 'automations', expectedKind: 'automation' },
  ];

  for (const { prop, expectedKind } of checks) {
    const propNode = getProperty(ts, opts, prop);
    if (!propNode) continue;

    const strings = getStringArrayElements(ts, propNode.initializer);
    for (const str of strings) {
      const el = registry.get(str.text);
      if (!el) {
        diagnostics.push(
          makeDiag(
            ts,
            sourceFile,
            str,
            `Unknown element "${str.text}"`,
            ts.DiagnosticCategory.Error,
          ),
        );
      } else if (expectedKind && el.kind !== expectedKind) {
        diagnostics.push(
          makeDiag(
            ts,
            sourceFile,
            str,
            `"${str.text}" is a ${el.kind}, expected a ${expectedKind}`,
            ts.DiagnosticCategory.Warning,
          ),
        );
      }
    }
  }
}

function makeDiag(
  ts: typeof import('typescript/lib/tsserverlibrary'),
  sourceFile: ts.SourceFile,
  node: ts.Node,
  message: string,
  category: ts.DiagnosticCategory,
): ts.Diagnostic {
  return {
    file: sourceFile,
    start: node.getStart(sourceFile),
    length: node.getWidth(sourceFile),
    messageText: message,
    category,
    code: EVFLOW_ERROR_BASE + (category === ts.DiagnosticCategory.Error ? 1 : 2),
    source: 'evflow',
  };
}
