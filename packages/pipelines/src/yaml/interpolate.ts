/**
 * Mustache-based string interpolation for YAML pipelines.
 *
 * Used to template prompts, messages, commands, and anywhere else a YAML
 * string field can reference pipeline state. Predicates (when/until) use
 * JSONata instead — see `predicates.ts`.
 *
 * Key choices:
 *   - HTML escaping is OFF. Pipeline strings end up in shell commands and
 *     LLM prompts, where HTML entities would corrupt the output.
 *   - Mustache's `{{var}}` (escaped) and `{{{var}}}` (raw) are equivalent
 *     here because escaping is disabled.
 *   - Dot-path access (`{{ review.output.verdict }}`) works out-of-the-box
 *     in Mustache 4.x.
 *   - Sections (`{{#findings}}...{{/findings}}`) and inverted sections
 *     (`{{^findings}}...{{/findings}}`) are supported for iteration and
 *     fall-through-on-empty respectively.
 */

import Mustache, { type TemplateSpans } from 'mustache';

// Disable HTML escaping globally — see header comment for rationale.
Mustache.escape = (text: string) => text;

/**
 * The data scope visible to templates. Includes:
 *   - Pipeline inputs (top-level keys)
 *   - Per-node outputs accessible by node id (e.g. `review.output.verdict`)
 *   - Reserved templating variables (`LAST_ERROR`, `REJECTION_REASON`, etc.)
 *
 * Implemented as `Record<string, unknown>` to keep the boundary simple —
 * the engine controls what goes in.
 */
export type TemplateScope = Record<string, unknown>;

export interface InterpolateOptions {
  /**
   * If true, throw on missing variables instead of rendering an empty
   * string. Useful for validating a pipeline's templates before running.
   * Default: false (Mustache's normal "render empty" behavior).
   */
  strict?: boolean;
}

export class TemplateInterpolationError extends Error {
  constructor(
    message: string,
    public readonly template: string,
  ) {
    super(message);
    this.name = 'TemplateInterpolationError';
  }
}

/**
 * Render a template string against the given scope.
 *
 * @example
 *   interpolate('Push {{branch}}?', { branch: 'feature/x' })
 *   // → 'Push feature/x?'
 *
 *   interpolate(
 *     '{{#findings}}- {{description}}\n{{/findings}}',
 *     { findings: [{ description: 'bug' }, { description: 'typo' }] }
 *   )
 *   // → '- bug\n- typo\n'
 */
export function interpolate(
  template: string,
  scope: TemplateScope,
  opts: InterpolateOptions = {},
): string {
  if (template.length === 0) return '';

  try {
    if (opts.strict) {
      // Mustache doesn't have a built-in strict mode — emulate it by
      // pre-scanning the template for variable tags and asserting each
      // path resolves to *something* in the scope (not undefined).
      const tokens = Mustache.parse(template);
      assertScopeCoversTokens(tokens, scope, template);
    }
    return Mustache.render(template, scope);
  } catch (err) {
    if (err instanceof TemplateInterpolationError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new TemplateInterpolationError(`Template render failed: ${message}`, template);
  }
}

/**
 * Convenience: interpolate a structured object recursively. String fields
 * are rendered against the scope; numbers/booleans/null pass through.
 *
 * Useful for action option blocks (`git_commit:`, `notify:`, etc.) that
 * may contain any number of templated string fields.
 */
export function interpolateObject<T>(value: T, scope: TemplateScope, opts?: InterpolateOptions): T {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    // SAFETY: `value` is a string here, and rendering a string template yields a string.
    return interpolate(value, scope, opts) as T & string;
  }
  if (Array.isArray(value)) {
    // SAFETY: `value` is an array here; the result maps it element by element, keeping its shape.
    return value.map((v) => interpolateObject(v, scope, opts)) as T & unknown[];
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = interpolateObject(v, scope, opts);
    }
    // SAFETY: `out` has exactly `value`'s own keys, each holding the interpolated field value.
    return out as T & Record<string, unknown>;
  }
  return value;
}

// ── Internal helpers ────────────────────────────────────────

function assertScopeCoversTokens(
  tokens: TemplateSpans,
  scope: TemplateScope,
  template: string,
): void {
  for (const tok of tokens) {
    const [type, key] = tok;
    // Variable tags (`{{x}}`, `{{{x}}}`, `{{&x}}`) — must resolve.
    if (type === 'name' || type === '&') {
      if (resolvePath(scope, key) === undefined) {
        throw new TemplateInterpolationError(`Missing variable "${key}" in template`, template);
      }
    }
    // Section / inverted section — recurse into children.
    if ((type === '#' || type === '^') && Array.isArray(tok[4])) {
      assertScopeCoversTokens(tok[4], scope, template);
    }
  }
}

function resolvePath(scope: TemplateScope, path: string): unknown {
  if (path === '.') return scope;
  const segments = path.split('.');
  let current: unknown = scope;
  for (const seg of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    // SAFETY: `current` is a non-null object here (both checked above); a missing key reads as
    // undefined, which ends the path.
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

/**
 * Every variable a template reads (sections included), as written:
 * `templateVariables('merge-{{repo}}-{{#a}}{{b.c}}{{/a}}')` is `['repo', 'a', 'b.c']`.
 * Throws `TemplateInterpolationError` when the template does not parse.
 */
export function templateVariables(template: string): string[] {
  let tokens: TemplateSpans;
  try {
    tokens = Mustache.parse(template);
  } catch (err) {
    throw new TemplateInterpolationError(
      `Template does not parse: ${err instanceof Error ? err.message : String(err)}`,
      template,
    );
  }
  return namesIn(tokens);
}

function namesIn(tokens: TemplateSpans): string[] {
  return tokens.flatMap((tok) => {
    const [type, key] = tok;
    const own = ['name', '&', '#', '^'].includes(type) ? [key] : [];
    // Sections keep their children at index 4.
    return [...own, ...(Array.isArray(tok[4]) ? namesIn(tok[4]) : [])];
  });
}
