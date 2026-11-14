/**
 * Factory settings (GLOSSARY.md): one user's configuration of their issue
 * factory, read from one YAML file. Secrets are never part of it (see
 * `secrets.ts`); `load.ts` refuses a file that looks like it holds one.
 */

import { z } from 'zod';

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

const projectSchema = z
  .object({
    /** The project's local checkout. */
    path: z.string().min(1),
    /** `owner/name` on GitHub. */
    repo: z.string().regex(REPO_RE, 'expected owner/name'),
    /** `sandbox` (default) runs the agent in a sandbox; `worktree` on this machine. */
    workspace: z.enum(['sandbox', 'worktree']).default('sandbox'),
    /** Base branch of the pull requests; default: the repository's default branch. */
    base: z.string().min(1).optional(),
    /** The repository's check command; without one, the pull request says no checks ran. */
    check: z.string().min(1).optional(),
  })
  .strict();

export const factorySettingsSchema = z
  .object({
    github: z
      .object({
        /** The user the factory works for: only their issues are admitted. */
        login: z.string().min(1),
        /** Commit author of the factory's commits. */
        author: z.object({ name: z.string().min(1), email: z.string().email() }).strict(),
      })
      .strict(),
    model: z.string().min(1),
    labels: z
      .object({
        ready: z.string().min(1).default('ready-for-agent'),
        in_progress: z.string().min(1).default('agent-in-progress'),
      })
      .strict()
      .prefault({}),
    limits: z
      .object({
        /** Runs working at once (claiming, working, fixing). */
        concurrency: z.number().int().min(1).default(2),
        /** New runs started per day. */
        daily: z.number().int().min(1).default(10),
      })
      .strict()
      .prefault({}),
    /** Enable GitHub auto-merge on green pull requests. Off by default. */
    auto_merge: z.boolean().default(false),
    /** Delay before retrying an infrastructure failure (then twice that). */
    retry_delay_minutes: z.number().int().min(1).default(30),
    sandbox: z
      .object({
        provider: z.string().min(1),
        size: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    projects: z.array(projectSchema).min(1),
  })
  .strict()
  .superRefine((settings, ctx) => {
    if (!settings.sandbox && usesSandbox(settings)) {
      ctx.addIssue({
        code: 'custom',
        path: ['sandbox'],
        message: 'required when a project uses the sandbox workspace',
      });
    }
  });

export type FactorySettings = z.infer<typeof factorySettingsSchema>;
export type FactoryProject = FactorySettings['projects'][number];

/** Whether any project runs in a sandbox (and so needs a sandbox credential). */
export function usesSandbox(settings: Pick<FactorySettings, 'projects'>): boolean {
  return settings.projects.some((p) => p.workspace === 'sandbox');
}
