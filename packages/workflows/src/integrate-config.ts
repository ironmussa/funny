/**
 * `.funny/integrate.yaml`: what the issue factory's `integrate` step may do
 * besides merging (openspec factory-integration D7). Read from the default
 * branch with the flow; every problem is reported at once, naming its field.
 *
 * ```yaml
 * regenerate:
 *   - paths: [bun.lock]
 *     run: bun install
 *     timeout_ms: 600000
 * checks:
 *   - bun run typecheck
 * ```
 */

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/** Where the file lives on the default branch. */
export const INTEGRATE_CONFIG_PATH = '.funny/integrate.yaml';

/** A regenerator or check may run for at most an hour (the runner refuses more). */
const MAX_TIMEOUT_MS = 3_600_000;
const DEFAULT_TIMEOUT_MS = 600_000;

export interface IntegrateRegenerator {
  /** Globs over repository paths: `*` and `?` within a segment, `**` across segments. */
  paths: string[];
  /** The command that rewrites those paths from the merged sources. */
  run: string;
  timeoutMs: number;
}

export interface IntegrateConfig {
  regenerators: IntegrateRegenerator[];
  /** Fast commands run on the merged tree before it is pushed. */
  checks: string[];
}

export interface IntegrateConfigProblem {
  field: string;
  message: string;
}

export type IntegrateConfigResult =
  | { ok: true; config: IntegrateConfig }
  | { ok: false; problems: IntegrateConfigProblem[] };

/** No file: nothing is regenerated and no check runs. */
export const EMPTY_INTEGRATE_CONFIG: IntegrateConfig = { regenerators: [], checks: [] };

const command = z.string().trim().min(1, 'a command is required').max(10_000);

const fileSchema = z
  .object({
    regenerate: z
      .array(
        z
          .object({
            paths: z.array(z.string()).min(1, 'at least one path is required'),
            run: command,
            timeout_ms: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
          })
          .strict(),
      )
      .max(50)
      .optional(),
    checks: z.array(command).max(20).optional(),
  })
  .strict();

/**
 * Why `glob` cannot match the way it reads, or null. Globs are relative to the
 * repository root; brackets and braces are not supported (they would match
 * themselves, not a set).
 */
function globProblem(glob: string): string | null {
  if (glob.trim() === '') return 'a path cannot be empty';
  if (glob.startsWith('/')) return `"${glob}" must be relative to the repository root`;
  if (glob.includes('\\')) return `"${glob}" must use / between directories`;
  if (glob.split('/').some((segment) => segment === '..' || segment === '')) {
    return `"${glob}" cannot contain .. or an empty segment`;
  }
  if (/[[\]{}]/.test(glob)) {
    return `"${glob}" uses [ ] or { }, which are not supported: use *, ? and **`;
  }
  return null;
}

function pathOf(path: PropertyKey[]): string {
  let text = '';
  for (const key of path) {
    if (typeof key === 'number') text += `[${key}]`;
    else text += text ? `.${String(key)}` : String(key);
  }
  return text;
}

/** Parse and validate the file's text. An empty file is the empty configuration. */
export function parseIntegrateConfig(text: string): IntegrateConfigResult {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    return {
      ok: false,
      problems: [
        { field: 'yaml', message: error instanceof Error ? error.message : String(error) },
      ],
    };
  }
  const parsed = fileSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((issue) => ({
        field: pathOf(issue.path) || 'file',
        message: issue.message,
      })),
    };
  }
  const regenerate = parsed.data.regenerate ?? [];
  const problems = regenerate.flatMap((entry, i) =>
    entry.paths.flatMap((glob, j) => {
      const message = globProblem(glob);
      return message ? [{ field: `regenerate[${i}].paths[${j}]`, message }] : [];
    }),
  );
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    config: {
      regenerators: regenerate.map((entry) => ({
        paths: entry.paths,
        run: entry.run,
        timeoutMs: entry.timeout_ms ?? DEFAULT_TIMEOUT_MS,
      })),
      checks: parsed.data.checks ?? [],
    },
  };
}
