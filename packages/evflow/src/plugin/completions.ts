import type ts from 'typescript/lib/tsserverlibrary';

import { isEvflowMethodCall, getMethodName } from './ast-utils.js';
import type { RegisteredElement } from './registry.js';

/**
 * Provide evflow-specific completions when the cursor is inside
 * a string literal in a known evflow context.
 *
 * Contexts:
 *   readModel({ from: ['|'] })          → suggest events
 *   automation({ on: '|' })             → suggest events
 *   automation({ triggers: '|' })       → suggest commands
 *   sequence('name', '... -> |')        → suggest all elements
 *   slice({ commands: ['|'], ... })     → suggest by kind
 */
export function getEvflowCompletions(
  ts: typeof import('typescript/lib/tsserverlibrary'),
  sourceFile: ts.SourceFile,
  position: number,
  registry: Map<string, RegisteredElement>,
): ts.CompletionEntry[] | undefined {
  // Find the innermost node at the cursor position
  const token = findTokenAtPosition(ts, sourceFile, position);
  if (!token || !ts.isStringLiteral(token)) return undefined;

  // Walk up to find the evflow call context
  const context = getCompletionContext(ts, token);
  if (!context) return undefined;

  const entries: ts.CompletionEntry[] = [];

  for (const el of registry.values()) {
    if (context.filter && !context.filter.includes(el.kind)) continue;

    entries.push({
      name: el.name,
      kind: kindToScriptElementKind(ts, el.kind),
      kindModifiers: '',
      sortText: `0_${el.name}`,
      labelDetails: { description: el.kind },
    });
  }

  return entries.length > 0 ? entries : undefined;
}

interface CompletionContext {
  /** Which kinds of elements to suggest. undefined = all */
  filter?: string[];
}

/**
 * Determine which evflow context the string literal is in,
 * and what kinds of elements should be suggested.
 */
function getCompletionContext(
  ts: typeof import('typescript/lib/tsserverlibrary'),
  stringNode: ts.StringLiteral,
): CompletionContext | undefined {
  // Walk parents: StringLiteral → ArrayLiteralExpression? → PropertyAssignment → ObjectLiteralExpression → CallExpression
  let current: ts.Node = stringNode;

  // If inside an array literal, go up one level
  if (current.parent && ts.isArrayLiteralExpression(current.parent)) {
    current = current.parent;
  }

  // Should be a PropertyAssignment or direct arg
  if (current.parent && ts.isPropertyAssignment(current.parent)) {
    const propAssignment = current.parent;
    const propName = ts.isIdentifier(propAssignment.name) ? propAssignment.name.text : '';

    // Go up to ObjectLiteralExpression → CallExpression
    const objLit = propAssignment.parent;
    if (!objLit || !ts.isObjectLiteralExpression(objLit)) return undefined;

    const callExpr = objLit.parent;
    if (!callExpr || !ts.isCallExpression(callExpr)) return undefined;
    if (!isEvflowMethodCall(ts, callExpr)) return undefined;

    const method = getMethodName(ts, callExpr);

    switch (method) {
      case 'readModel':
        if (propName === 'from') return { filter: ['event'] };
        break;
      case 'automation':
        if (propName === 'on') return { filter: ['event'] };
        if (propName === 'triggers') return { filter: ['command'] };
        break;
      case 'slice':
        if (propName === 'commands') return { filter: ['command'] };
        if (propName === 'events') return { filter: ['event'] };
        if (propName === 'readModels') return { filter: ['readModel'] };
        if (propName === 'automations') return { filter: ['automation'] };
        break;
    }

    return undefined;
  }

  // Direct string arg: sequence('name', 'A -> B -> |')
  if (current.parent && ts.isCallExpression(current.parent)) {
    const call = current.parent;
    if (!isEvflowMethodCall(ts, call)) return undefined;
    const method = getMethodName(ts, call);

    if (method === 'sequence' && call.arguments[1] === stringNode) {
      // All element types valid in sequences
      return { filter: undefined };
    }
  }

  return undefined;
}

function findTokenAtPosition(
  ts: typeof import('typescript/lib/tsserverlibrary'),
  sourceFile: ts.SourceFile,
  position: number,
): ts.Node | undefined {
  function find(node: ts.Node): ts.Node | undefined {
    if (position >= node.getStart(sourceFile) && position <= node.getEnd()) {
      const child = ts.forEachChild(node, find);
      return child || node;
    }
    return undefined;
  }
  return find(sourceFile);
}

function kindToScriptElementKind(
  ts: typeof import('typescript/lib/tsserverlibrary'),
  kind: string,
): ts.ScriptElementKind {
  switch (kind) {
    case 'command':
      return ts.ScriptElementKind.functionElement;
    case 'event':
      return ts.ScriptElementKind.classElement;
    case 'readModel':
      return ts.ScriptElementKind.interfaceElement;
    case 'automation':
      return ts.ScriptElementKind.moduleElement;
    default:
      return ts.ScriptElementKind.unknown;
  }
}
