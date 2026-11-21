/**
 * The kinds of background activity (track-background-activities, design D3).
 *
 * Each kind declares the schema of the input it records. The server parses an
 * activity's input with it when the activity starts; zod's default object
 * parsing drops undeclared fields, so a stray token never reaches the row. The
 * client reads the same schemas when it refills a form to retry.
 *
 * Browser-safe: zod only.
 *
 * To add a kind: declare it here, wrap the operation with the runner's
 * `trackActivity`, and add its retry target in the client's `lib/activity-retry.ts`.
 */
import { z } from 'zod';

/** Removes the user and password of a URL (`https://user:token@host/x` → `https://host/x`). */
export function stripUrlCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return url;
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    // Not a URL git would read as one with credentials (scp-like `git@host:x`).
    return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1');
  }
}

const cloneUrl = z
  .string()
  .max(2048)
  .transform((value) => stripUrlCredentials(value));

export const ACTIVITY_KINDS = {
  'project.clone': {
    scope: 'none',
    input: z.object({
      cloneUrl,
      destinationPath: z.string().max(4096),
      name: z.string().max(256).optional(),
    }),
  },
  'worktree.setup': {
    scope: 'thread',
    input: z.object({
      branch: z.string().max(512).optional(),
      baseBranch: z.string().max(512).optional(),
    }),
  },
  'git.workflow': {
    scope: 'thread',
    input: z.object({
      action: z.enum([
        'commit',
        'amend',
        'commit-push',
        'commit-pr',
        'commit-merge',
        'push',
        'merge',
        'create-pr',
      ]),
    }),
  },
} as const;

export type ActivityKind = keyof typeof ACTIVITY_KINDS;

export type ActivityInput<K extends ActivityKind> = z.output<(typeof ACTIVITY_KINDS)[K]['input']>;

export function isActivityKind(kind: string): kind is ActivityKind {
  return Object.hasOwn(ACTIVITY_KINDS, kind);
}

/**
 * Validates an activity input against its kind. Returns the stripped input, or
 * null for an unknown kind or an input that does not match.
 */
export function parseActivityInput(kind: string, input: unknown): Record<string, unknown> | null {
  if (!isActivityKind(kind)) return null;
  const parsed = ACTIVITY_KINDS[kind].input.safeParse(input ?? {});
  return parsed.success ? (parsed.data as Record<string, unknown>) : null;
}

/** The longest title and error text an activity records. */
export const ACTIVITY_TITLE_MAX = 200;
export const ACTIVITY_ERROR_MAX = 4000;
export const ACTIVITY_STEP_MAX = 200;
