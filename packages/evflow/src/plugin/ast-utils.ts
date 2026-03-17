import type ts from 'typescript/lib/tsserverlibrary';

/** Method names we look for on an EventModel instance */
export const EVFLOW_METHODS = [
  'command',
  'event',
  'readModel',
  'automation',
  'sequence',
  'slice',
] as const;
export type EvflowMethod = (typeof EVFLOW_METHODS)[number];

/** Map method names to element kinds */
export const METHOD_TO_KIND: Record<string, string> = {
  command: 'command',
  event: 'event',
  readModel: 'readModel',
  automation: 'automation',
};

/**
 * Check if a node is a call expression like `<expr>.methodName(...)`
 * where methodName is one of the evflow methods.
 */
export function isEvflowMethodCall(
  ts: typeof import('typescript/lib/tsserverlibrary'),
  node: ts.Node,
  methodName?: string,
): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const expr = node.expression;
  if (!ts.isPropertyAccessExpression(expr)) return false;
  const name = expr.name.text;
  if (methodName) return name === methodName;
  return (EVFLOW_METHODS as readonly string[]).includes(name);
}

/**
 * Get the method name from a call expression like `sys.command(...)` → "command"
 */
export function getMethodName(
  ts: typeof import('typescript/lib/tsserverlibrary'),
  call: ts.CallExpression,
): string | undefined {
  const expr = call.expression;
  if (ts.isPropertyAccessExpression(expr)) {
    return expr.name.text;
  }
  return undefined;
}

/**
 * Extract the first string literal argument from a call expression.
 * e.g. `sys.command('AddItem', {...})` → "AddItem"
 */
export function getFirstStringArg(
  ts: typeof import('typescript/lib/tsserverlibrary'),
  call: ts.CallExpression,
): ts.StringLiteral | undefined {
  const arg = call.arguments[0];
  if (arg && ts.isStringLiteral(arg)) return arg;
  return undefined;
}

/**
 * Get the second argument of a call if it's an object literal.
 * e.g. `sys.readModel('X', { from: [...] })` → the ObjectLiteralExpression
 */
export function getOptionsArg(
  ts: typeof import('typescript/lib/tsserverlibrary'),
  call: ts.CallExpression,
): ts.ObjectLiteralExpression | undefined {
  const arg = call.arguments[1];
  if (arg && ts.isObjectLiteralExpression(arg)) return arg;
  return undefined;
}

/**
 * Find a property by name in an object literal.
 * e.g. `{ from: ['A'], fields: {} }` → find 'from' → PropertyAssignment
 */
export function getProperty(
  ts: typeof import('typescript/lib/tsserverlibrary'),
  obj: ts.ObjectLiteralExpression,
  propName: string,
): ts.PropertyAssignment | undefined {
  for (const prop of obj.properties) {
    if (
      ts.isPropertyAssignment(prop) &&
      ts.isIdentifier(prop.name) &&
      prop.name.text === propName
    ) {
      return prop;
    }
  }
  return undefined;
}

/**
 * Extract all string literals from an array literal expression.
 * e.g. `['A', 'B', 'C']` → [StringLiteral('A'), StringLiteral('B'), StringLiteral('C')]
 */
export function getStringArrayElements(
  ts: typeof import('typescript/lib/tsserverlibrary'),
  node: ts.Node,
): ts.StringLiteral[] {
  if (!ts.isArrayLiteralExpression(node)) return [];
  return node.elements.filter((el): el is ts.StringLiteral => ts.isStringLiteral(el));
}

/**
 * Get a string literal value from a property assignment.
 * e.g. `{ on: 'CheckoutStarted' }` → find 'on' → StringLiteral
 */
export function getStringProperty(
  ts: typeof import('typescript/lib/tsserverlibrary'),
  obj: ts.ObjectLiteralExpression,
  propName: string,
): ts.StringLiteral | undefined {
  const prop = getProperty(ts, obj, propName);
  if (prop && ts.isStringLiteral(prop.initializer)) {
    return prop.initializer;
  }
  return undefined;
}

/**
 * Get string elements from an array property or a single string property.
 * Handles both `triggers: 'X'` and `triggers: ['X', 'Y']`.
 */
export function getStringOrArrayProperty(
  ts: typeof import('typescript/lib/tsserverlibrary'),
  obj: ts.ObjectLiteralExpression,
  propName: string,
): ts.StringLiteral[] {
  const prop = getProperty(ts, obj, propName);
  if (!prop) return [];

  if (ts.isStringLiteral(prop.initializer)) {
    return [prop.initializer];
  }
  if (ts.isArrayLiteralExpression(prop.initializer)) {
    return getStringArrayElements(ts, prop.initializer);
  }
  return [];
}

/**
 * Parse a sequence string like "A -> B -> C" and return the position
 * info for each step name within the string literal.
 */
export function parseSequenceString(
  value: string,
  stringStart: number,
): Array<{ name: string; start: number; length: number }> {
  const steps: Array<{ name: string; start: number; length: number }> = [];
  const parts = value.split('->');
  let offset = 0;

  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed) {
      const nameStart = value.indexOf(trimmed, offset);
      steps.push({
        name: trimmed,
        // +1 for the opening quote of the string literal
        start: stringStart + 1 + nameStart,
        length: trimmed.length,
      });
    }
    offset += part.length + 2; // +2 for "->"
  }

  return steps;
}
