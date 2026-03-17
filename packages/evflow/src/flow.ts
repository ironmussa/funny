import type { ElementRef, SequenceStep } from './types.js';

/**
 * Tagged template literal for defining sequences.
 *
 * Usage:
 *   flow`${AddItemToCart} -> ${ItemAddedToCart} -> ${CartView}`
 *
 * The static string parts between interpolations must be `->` arrows
 * (with optional whitespace). The interpolated values must be ElementRef
 * objects (returned by system.command(), system.event(), etc.).
 *
 * If a variable does not exist, JS throws ReferenceError automatically —
 * this gives free compile-time validation.
 */
export function parseFlow(strings: TemplateStringsArray, values: ElementRef[]): SequenceStep[] {
  if (values.length === 0) {
    return [];
  }

  for (let i = 0; i < strings.length; i++) {
    const part = strings[i].trim();

    // First and last parts can be empty whitespace
    if (i === 0 || i === strings.length - 1) {
      if (part !== '' && part !== '->') {
        throw new Error(
          `flow: unexpected text "${part}". All elements must be interpolated variables.\n` +
            `Use: flow\`\${A} -> \${B} -> \${C}\``,
        );
      }
      continue;
    }

    // Middle parts must be exactly "->"
    if (part !== '->') {
      throw new Error(
        `flow: expected "->" between elements, got "${part}".\n` +
          `Use: flow\`\${A} -> \${B} -> \${C}\``,
      );
    }
  }

  for (const val of values) {
    if (!val || typeof val.name !== 'string' || typeof val.kind !== 'string') {
      throw new Error(
        `flow: interpolated value must be an ElementRef ` +
          `(returned by system.command(), system.event(), etc.), got: ${String(val)}`,
      );
    }
  }

  return values.map((v) => ({ name: v.name, kind: v.kind }));
}

/**
 * Parse a string-based sequence like "A -> B -> C".
 * Returns array of element name strings.
 */
export function parseStringSequence(input: string): string[] {
  return input
    .split('->')
    .map((s) => s.trim())
    .filter(Boolean);
}
