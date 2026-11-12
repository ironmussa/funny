/**
 * The public REST API v1 (openspec public-rest-api-v1): inputs and published
 * outputs. Every field here is a public contract: an output schema lists
 * exactly what a response may carry, and undeclared fields are stripped.
 */

import { z } from 'zod';

import { DEFAULT_PROVIDER, MODEL_REGISTRY } from '../models.js';

/** A project as the public API shows it: never its path on a runner's disk. */
export const publicProject = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().optional(),
  /** URL patterns that resolve a page to this project. */
  urls: z.array(z.string()).optional(),
  /** Shared with the caller by its owner (not owned by the caller). */
  shared: z.boolean(),
});

export const publicProjectList = z.object({ projects: z.array(publicProject) });

export const resolveProjectInput = z.object({
  /** The page URL to match against each project's URL patterns. */
  url: z.string().min(1).max(2048),
});

export const resolveProjectOutput = z.object({
  project: publicProject.nullable(),
  source: z.enum(['url_match', 'none']),
});

export type PublicProject = z.output<typeof publicProject>;

// ── Threads ─────────────────────────────────────────────────────

/** Largest decoded image the public API accepts (the Anthropic API's per-image limit). */
export const PUBLIC_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** Images per thread: 4 × 5 MB stays under the runner connection's 32 MB message limit. */
const PUBLIC_IMAGES_MAX = 4;
const BASE64_MAX_CHARS = Math.ceil(PUBLIC_IMAGE_MAX_BYTES / 3) * 4;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/**
 * Largest request body the public API reads: four maximal images plus a
 * maximal prompt and the rest of the JSON (about 28.4 MB), under the runner
 * connection's 32 MB message limit. Anything larger answers 413 unread.
 */
export const PUBLIC_BODY_MAX_BYTES = 30 * 1024 * 1024;

/** Bytes a base64 string decodes to. */
const decodedBytes = (data: string) =>
  (data.length / 4) * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);

const publicImage = z.object({
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  /** The image bytes, base64-encoded (no `data:` prefix), at most 5 MB decoded. */
  data: z
    .string()
    .min(4)
    .max(BASE64_MAX_CHARS, 'Image larger than 5 MB')
    .refine((d) => d.length % 4 === 0 && BASE64.test(d), 'Image data must be base64')
    .refine((d) => decodedBytes(d) <= PUBLIC_IMAGE_MAX_BYTES, 'Image larger than 5 MB'),
});

/**
 * Permission modes a public API caller may choose. The modes that run tools
 * without asking (`autoEdit`, which is Claude's `bypassPermissions`, and
 * `auto`, where a classifier approves each call) are not offered: a token is
 * a credential that lives outside the browser, so what it starts asks before
 * it acts. The web app's default (`autoEdit`) is deliberately not used.
 */
const publicPermissionMode = z.enum(['ask', 'confirmEdit', 'plan']);

const registryProviders = Object.keys(MODEL_REGISTRY) as [
  keyof typeof MODEL_REGISTRY,
  ...(keyof typeof MODEL_REGISTRY)[],
];

export const createThreadInput = z
  .object({
    projectId: z.string().min(1).max(200),
    prompt: z.string().min(1).max(100_000),
    title: z.string().max(200).optional(),
    images: z.array(publicImage).max(PUBLIC_IMAGES_MAX).optional(),
    /** `local` runs in the project's checkout; `worktree` on a new branch in its own worktree. */
    mode: z.enum(['local', 'worktree']).default('local'),
    /** A provider id from `GET /models`. Defaults to the project's provider. */
    provider: z.enum(registryProviders).optional(),
    /** A model id from `GET /models` for the provider (Claude when no provider is given). */
    model: z.string().min(1).max(100).optional(),
    /** Defaults to `ask`. Modes that act without asking are refused. */
    permissionMode: publicPermissionMode.default('ask'),
    /** Who is calling, recorded as the thread's source (`api` when absent). */
    client: z.enum(['chrome_extension']).optional(),
  })
  .superRefine((input, ctx) => {
    if (input.model === undefined) return;
    const provider = (input.provider ?? DEFAULT_PROVIDER) as keyof typeof MODEL_REGISTRY;
    // `hasOwn`, not `in`: `toString` is not a model.
    if (!Object.hasOwn(MODEL_REGISTRY[provider], input.model)) {
      ctx.addIssue({
        code: 'custom',
        path: ['model'],
        message: `Unknown model "${input.model}" for provider "${provider}"`,
      });
    }
  });

export type CreateThreadInput = z.output<typeof createThreadInput>;

const publicThread = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  status: z.string(),
  createdAt: z.string(),
});

export const createThreadOutput = z.object({ thread: publicThread });

export type PublicThread = z.output<typeof publicThread>;

// ── Models ──────────────────────────────────────────────────────

export const publicModelList = z.object({
  defaultProvider: z.string(),
  providers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      defaultModel: z.string(),
      models: z.array(z.object({ id: z.string(), name: z.string() })),
    }),
  ),
});

export type PublicModelList = z.output<typeof publicModelList>;
