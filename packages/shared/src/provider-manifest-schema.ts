/**
 * Strict zod validator for external `funny.provider` manifests
 * (provider-manifest-loader, Phase B). This is the security core of the
 * declarative-only design: an external manifest may only SELECT behaviors from
 * the frozen in-core menu — it can never DEFINE new ones.
 *
 * Every object is `.strict()` (unknown keys rejected), every menu selector is a
 * closed `z.enum`, and the only imperative selector (`prelaunch`) is a single
 * named literal. A manifest that references a quirk flag, selector value, or
 * `prelaunch` action the core doesn't implement fails validation — adding one
 * is a reviewed core change, not a manifest.
 *
 * The schema mirrors the frozen `ProviderManifest` contract; the
 * `_assertAssignable` checks below keep the two in sync at compile time.
 */

import { z } from 'zod';

import type { ProviderManifest } from './provider-manifest.js';

/** Bumped when the on-disk `funny.provider.json` shape changes incompatibly. */
export const PROVIDER_MANIFEST_SCHEMA_VERSION = 1;

/**
 * Upper bound on a banner-strip regex source. A short cap is the primary ReDoS
 * mitigation at validation time (catastrophic backtracking is undecidable to
 * detect statically); core additionally bounds the input it applies the regex
 * to. The built-in pi banner is ~60 chars, so 500 is generous.
 */
export const MAX_BANNER_REGEX_LEN = 500;

const modelDefinitionSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    contextWindow: z.number().int().positive(),
    i18nKey: z.string().min(1),
  })
  .strict();

const spawnSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()),
    binEnvVars: z.array(z.string()),
    npxSpec: z
      .object({ useEnvVar: z.string().min(1), pkg: z.array(z.string()) })
      .strict()
      .optional(),
  })
  .strict();

const modelStrategySchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('static'),
      entries: z.record(z.string(), modelDefinitionSchema),
      defaultModel: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('dynamic'),
      sentinel: modelDefinitionSchema,
      defaultModel: z.string().min(1),
    })
    .strict(),
]);

const bannerRegexSchema = z
  .string()
  .max(MAX_BANNER_REGEX_LEN)
  .refine(
    (src) => {
      try {
        // eslint-disable-next-line no-new
        new RegExp(src);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'stripFirstMessageBanner is not a valid regular expression' },
  );

/** The closed quirk menu — keys AND value enums must match the in-core set. */
const quirksSchema = z
  .object({
    bufferPreambleAsThink: z.boolean().optional(),
    planRender: z.enum(['text', 'todoCard']).optional(),
    deferUnrenderableToolInput: z.boolean().optional(),
    synthToolUseFromOrphanUpdate: z.boolean().optional(),
    stripFirstMessageBanner: bannerRegexSchema.optional(),
    permissionModel: z.enum(['gated', 'auto-allow']).optional(),
    filterMcpByCapability: z.boolean().optional(),
    splitGluedAgentMessages: z.boolean().optional(),
  })
  .strict();

// All five funny PermissionModes, each mapped to a provider-native mode id or
// null. Explicit keys (not a computed record) so the inferred type is precise
// `Record<PermissionMode, string | null>` and the contract-sync guards hold.
const modeMapSchema = z
  .object({
    plan: z.string().nullable(),
    auto: z.string().nullable(),
    autoEdit: z.string().nullable(),
    confirmEdit: z.string().nullable(),
    ask: z.string().nullable(),
  })
  .strict();

/** A single ACP provider manifest — the validated, declarative-only contract. */
export const providerManifestSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9._-]*$/, 'id must be lowercase alphanumeric (._- allowed)'),
    label: z.string().min(1),
    kind: z.literal('acp'),
    spawn: spawnSchema,
    models: modelStrategySchema,
    setModel: z
      .object({ method: z.enum(['unstable_setSessionModel', 'session/set_model']) })
      .strict()
      .optional(),
    modelVia: z.enum(['acp-method', 'cli-arg']),
    modeVia: z.enum(['acp-setSessionMode', 'cli-flag', 'none']),
    modeMap: modeMapSchema,
    forkCapabilityPaths: z.array(z.string().min(1)),
    builtinTools: z.array(z.string()),
    attachmentLimits: z
      .object({
        inlineMaxBytes: z.number().int().nonnegative(),
        uploadMaxBytes: z.number().int().nonnegative(),
        hardMaxBytes: z.number().int().nonnegative(),
      })
      .strict(),
    auth: z
      .object({
        mode: z.enum(['runner-preauth', 'provider-key']),
        providerKeyId: z.string().min(1).optional(),
      })
      .strict(),
    prelaunch: z.enum(['gemini-trust-folder']).optional(),
    quirks: quirksSchema,
  })
  .strict();

/**
 * The on-disk `funny.provider.json` shape: a versioned envelope around the
 * manifest. `funny.provider` in an extension's `package.json` points at this.
 */
export const funnyProviderFileSchema = z
  .object({
    schemaVersion: z.literal(PROVIDER_MANIFEST_SCHEMA_VERSION),
    manifest: providerManifestSchema,
  })
  .strict();

export type ValidatedProviderManifest = z.infer<typeof providerManifestSchema>;
export type FunnyProviderFile = z.infer<typeof funnyProviderFileSchema>;

// ── Contract sync guards (compile-time only) ──────────────────────────────
// Keep the zod schema and the frozen `ProviderManifest` contract in lockstep:
// if either drifts, one of these assignments fails to type-check.
const _assertSchemaMatchesContract: ProviderManifest = {} as ValidatedProviderManifest;
const _assertContractMatchesSchema: ValidatedProviderManifest = {} as ProviderManifest;
void _assertSchemaMatchesContract;
void _assertContractMatchesSchema;

/**
 * Parse + validate an unknown value as a `funny.provider.json` file. Never
 * throws — returns a typed result so the loader can skip a bad manifest and
 * keep the others.
 */
export function parseFunnyProviderFile(
  raw: unknown,
): { ok: true; file: FunnyProviderFile } | { ok: false; error: string } {
  const result = funnyProviderFileSchema.safeParse(raw);
  if (result.success) return { ok: true, file: result.data };
  const first = result.error.issues[0];
  const path = first?.path.length ? `${first.path.join('.')}: ` : '';
  return { ok: false, error: `${path}${first?.message ?? 'invalid manifest'}` };
}
