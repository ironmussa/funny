import type ts from 'typescript/lib/tsserverlibrary';

import {
  isEvflowMethodCall,
  getMethodName,
  getFirstStringArg,
  METHOD_TO_KIND,
} from './ast-utils.js';

export interface RegisteredElement {
  name: string;
  kind: string; // 'command' | 'event' | 'readModel' | 'automation'
  /** Position of the name string literal in the source file */
  nameStart: number;
  nameEnd: number;
  fileName: string;
}

/**
 * Scans a source file's AST and extracts all evflow element registrations.
 *
 * Looks for patterns like:
 *   <variable>.command('AddItem', { ... })
 *   <variable>.event('ItemAdded', { ... })
 *   <variable>.readModel('CartView', { ... })
 *   <variable>.automation('TriggerPayment', { ... })
 */
export function buildRegistry(
  ts: typeof import('typescript/lib/tsserverlibrary'),
  sourceFile: ts.SourceFile,
): Map<string, RegisteredElement> {
  const registry = new Map<string, RegisteredElement>();

  function visit(node: ts.Node): void {
    if (isEvflowMethodCall(ts, node)) {
      const call = node as ts.CallExpression;
      const method = getMethodName(ts, call);
      if (!method) return;

      const kind = METHOD_TO_KIND[method];
      if (!kind) {
        // sequence, slice, etc. — not element registrations
        ts.forEachChild(node, visit);
        return;
      }

      const nameNode = getFirstStringArg(ts, call);
      if (!nameNode) {
        ts.forEachChild(node, visit);
        return;
      }

      registry.set(nameNode.text, {
        name: nameNode.text,
        kind,
        nameStart: nameNode.getStart(sourceFile),
        nameEnd: nameNode.getEnd(),
        fileName: sourceFile.fileName,
      });
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return registry;
}

/**
 * Build a registry across all project files that contain evflow usage.
 */
export function buildProjectRegistry(
  ts: typeof import('typescript/lib/tsserverlibrary'),
  program: ts.Program,
): Map<string, RegisteredElement> {
  const registry = new Map<string, RegisteredElement>();

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    if (sourceFile.fileName.includes('node_modules')) continue;

    const fileRegistry = buildRegistry(ts, sourceFile);
    for (const [name, element] of fileRegistry) {
      registry.set(name, element);
    }
  }

  return registry;
}
