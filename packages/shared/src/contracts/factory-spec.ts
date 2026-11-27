/**
 * The run contract and the spec stage of the issue factory (openspec
 * factory-spec-stage), split out of `factory.ts` and re-exported by it: the
 * contract triage (or an approved spec) writes, the open product decisions
 * triage hands to the spec writer, the spec writer's results, what a run
 * stores of its spec, and the reviewer's answer to each validation item.
 */

import { z } from 'zod';

const projectId = z.string().min(1);

/** One line of a contract. */
const contractLine = z.string().trim().min(1).max(500);

/** What the run must do, written by triage and read by the implementer and the reviewer. */
export const factoryContractSchema = z.object({
  /** What must be true for the issue to be done. */
  acceptanceCriteria: z.array(contractLine).min(1).max(20),
  /** Globs of the files the change will probably touch (a prediction). */
  likelyPaths: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  /** Why the change may be risky; any hint makes it high risk. */
  riskHints: z.array(contractLine).max(10).default([]),
  /**
   * Triage read the issue as asking only to clear lint or type-check warnings,
   * with no change in behavior. A proposal: it counts only when every rule in
   * `lintRules` is one whose fix cannot change behavior
   * (`BEHAVIOR_NEUTRAL_LINT_RULES`), the factory still checks the diff
   * (`lintCleanupRefusals`), and a member can say otherwise.
   */
  lintCleanup: z.boolean().optional(),
  /** The lint rules the issue asks to clear, as the linter names them (`eslint/max-lines`). */
  lintRules: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
});
export type FactoryContract = z.infer<typeof factoryContractSchema>;

/** At most this many open decisions triage hands to the spec writer, and lines of findings. */
export const MAX_SPEC_DECISIONS = 10;
export const MAX_TRIAGE_FINDINGS = 10;

const specLine = z.string().trim().min(1).max(1000);

/** One open product decision triage found, with the answers it sees. */
export const factoryOpenDecisionSchema = z.object({
  question: specLine,
  options: z.array(z.string().trim().min(1).max(300)).max(6).default([]),
});
export type FactoryOpenDecision = z.infer<typeof factoryOpenDecisionSchema>;

export const factoryNeedsSpecAnswerSchema = z.object({
  decision: z.literal('needs_spec'),
  decisions: z.array(factoryOpenDecisionSchema).min(1).max(MAX_SPEC_DECISIONS),
  /** What triage learned in the code, for the spec writer. */
  findings: z.array(specLine).max(MAX_TRIAGE_FINDINGS).default([]),
});

/**
 * Where an approved spec is committed (`docs/specs`): a directory relative to
 * the repository root, never absolute and never climbing out of it. Empty:
 * the spec is not committed.
 */
export const factoryCommitSpecPathSchema = z
  .string()
  .trim()
  .max(200)
  .refine((path) => path === '' || isRepositoryRelativePath(path), {
    message: 'A directory relative to the repository root, without `..`',
  });

/** A relative path inside the repository: no leading `/` or drive, no `..` segment, no backslash. */
export function isRepositoryRelativePath(path: string): boolean {
  if (path.startsWith('/') || path.startsWith('~') || /^[a-zA-Z]:/.test(path)) return false;
  if (path.includes('\\') || path.includes('\0')) return false;
  return path.split('/').every((segment) => segment !== '..');
}

/** The reviewer's answer to one validation item of the run's approved spec. */
export const factoryChecklistAnswerSchema = z.object({
  /** The item, as the spec states it. */
  item: z.string().trim().min(1).max(500),
  met: z.boolean(),
  note: z.string().max(1000).optional(),
});
export type FactoryChecklistAnswer = z.infer<typeof factoryChecklistAnswerSchema>;

/**
 * The spec stage (openspec factory-spec-stage). A draft: what the team
 * decided and what the implementer and the reviewer are held to.
 */
export const factorySpecSchema = z.object({
  summary: z.string().trim().min(1).max(2000),
  /** The decisions taken, each with the answer it got. */
  decisions: z
    .array(z.object({ question: specLine, answer: specLine }))
    .max(20)
    .default([]),
  /** What the product does once the change is in. */
  behavior: z.array(specLine).max(30).default([]),
  /** How it is built, as far as the spec fixes it. */
  approach: z.array(specLine).max(30).default([]),
  outOfScope: z.array(specLine).max(20).default([]),
  /** What the reviewer checks, one item each. */
  validation: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
  contract: factoryContractSchema,
});
export type FactorySpec = z.infer<typeof factorySpecSchema>;

/** What a spec writer's turn ends with: more questions, or a draft. */
export const factorySpecResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('questions'),
    questions: z.array(factoryOpenDecisionSchema).min(1).max(MAX_SPEC_DECISIONS),
  }),
  z.object({ status: z.literal('draft'), spec: factorySpecSchema }),
]);
export type FactorySpecResult = z.infer<typeof factorySpecResultSchema>;

/** The spec a member approved: the draft, its revision, who and when. */
export const factorySpecApprovalSchema = z.object({
  spec: factorySpecSchema,
  revision: z.number().int().nonnegative(),
  by: z.string(),
  at: z.string(),
});
export type FactorySpecApproval = z.infer<typeof factorySpecApprovalSchema>;

/** What a run stores of its spec stage (`factory_runs.spec`). */
export const factoryRunSpecSchema = z.object({
  /** The spec writer's thread; absent until it was launched. */
  threadId: z.string().optional(),
  /** The latest valid result, or absent before the first one. */
  latest: factorySpecResultSchema.optional(),
  latestAt: z.string().optional(),
  /** Increments on every stored result; an approval names it. */
  revision: z.number().int().nonnegative().default(0),
  /** Why the last turn stored nothing (`no valid result`), cleared by the next valid one. */
  problem: z.string().optional(),
  approved: factorySpecApprovalSchema.optional(),
});
export type FactoryRunSpec = z.infer<typeof factoryRunSpecSchema>;

/** The draft a member can approve now: the latest result, when it is a draft. */
export function pendingSpecDraft(spec: FactoryRunSpec | null): FactorySpec | null {
  return spec?.latest?.status === 'draft' ? spec.latest.spec : null;
}

/** The spec the run is held to: the approved one, or null. */
export const approvedSpecOf = (run: { spec: FactoryRunSpec | null }): FactorySpec | null =>
  run.spec?.approved?.spec ?? null;

/** A member approving the draft of `revision` (from the browser only). */
export const factoryApproveSpecInput = z
  .object({ projectId, runId: z.string().min(1), revision: z.number().int().nonnegative() })
  .strict();

/**
 * Triage (change factory-agent-roles, D4): what a triage answer may be, and
 * what the run stores of it.
 */
/** At most this many questions (or parts) go on the issue, each this long. */
export const MAX_TRIAGE_ITEMS = 5;
export const MAX_TRIAGE_ITEM_CHARS = 300;

const triageItems = z.array(z.string().trim().min(1).max(2000)).min(1).max(20);

export const factoryTriageResultSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('ready'), contract: factoryContractSchema }),
  z.object({ decision: z.literal('needs_info'), questions: triageItems }),
  /**
   * `parts`: the new issues to open. `existing`: issues that already cover
   * part of the work (a tracking issue's sub-issues, the parts of an earlier
   * split); they are named, never opened again. At least one of the two.
   */
  z
    .object({
      decision: z.literal('too_big'),
      parts: z.array(z.string().trim().min(1).max(2000)).max(20).default([]),
      existing: z.array(z.number().int().positive()).max(50).default([]),
    })
    .refine((answer) => answer.parts.length + answer.existing.length > 0, {
      message: 'name at least one part or one existing issue',
      path: ['parts'],
    }),
  /**
   * What the issue asks is already true of the code (a duplicate already
   * merged, a fix that landed): the factory says so on the issue, closes it
   * and ends the run `done`. `evidence`: what shows it (the commit or pull
   * request, the check that passes now).
   */
  z.object({ decision: z.literal('already_done'), evidence: triageItems }),
  /**
   * No change to this repository would fix what the issue reports (a failure
   * outside the code: a client's network, an outage of a service the
   * repository does not configure): the factory says so on the issue, closes
   * it as not planned and ends the run `done`. `evidence`: what in the issue
   * and the code shows it.
   */
  z.object({ decision: z.literal('not_actionable'), evidence: triageItems }),
  /**
   * The issue is workable but leaves product decisions open that a wrong
   * guess would waste (openspec factory-spec-stage). Only valid while the
   * factory's Spec stage is on (`triageResultSchemaFor`). Nothing is posted on
   * the issue: a spec writer settles them with the team.
   */
  factoryNeedsSpecAnswerSchema,
]);
export type FactoryTriageResult = z.infer<typeof factoryTriageResultSchema>;

/**
 * The triage results a factory accepts: `needs_spec` only while its Spec
 * stage is on, so a factory never parks on an answer it did not opt into.
 */
export function triageResultSchemaFor(specStage: boolean) {
  if (specStage) return factoryTriageResultSchema;
  return factoryTriageResultSchema.refine((answer) => answer.decision !== 'needs_spec', {
    message: 'needs_spec is not offered: the factory has no spec stage',
    path: ['decision'],
  });
}

/**
 * What the run stores of its triage. `none`: triage gave no valid result
 * twice, and the run went on without a contract.
 */
export const factoryTriageSchema = z.object({
  decision: z.enum([
    'ready',
    'needs_info',
    'needs_spec',
    'too_big',
    'already_done',
    'not_actionable',
    'none',
  ]),
  /** When triage answered; an issue changed after it is triaged again. */
  at: z.string(),
  /** The triage agent's thread. */
  threadId: z.string().optional(),
  /** The contract, for `ready`. */
  contract: factoryContractSchema.optional(),
  /** What was asked on the issue (`needs_info`), the proposed split (`too_big`), or the evidence (`already_done`, `not_actionable`). */
  items: z.array(z.string()).optional(),
  /**
   * The issue changed since (or a member retried): this answer is kept to show
   * what was asked, and triage runs again on a new thread, not `threadId`.
   */
  superseded: z.boolean().optional(),
  /** For `too_big`: the existing issues triage said already cover part of the work. */
  existing: z.array(z.number().int().positive()).optional(),
  /**
   * For `too_big` with the factory's `split` setting: the issues opened for
   * the parts, in the order of `items` (filled as each one is opened).
   */
  splitInto: z.array(z.number().int().positive()).optional(),
  /**
   * For a run that handed its issue's work to other issues (`splitInto`,
   * `existing`): when the factory saw every one of them closed and closed the
   * issue (or found it closed already). Its work is finished from then on.
   */
  partsClosedAt: z.string().optional(),
  /** For `needs_spec`: the open product decisions handed to the spec writer. */
  decisions: z.array(factoryOpenDecisionSchema).optional(),
  /** For `needs_spec`: what triage learned in the code. */
  findings: z.array(z.string()).optional(),
  /**
   * A `ready` answer written by a member's approval of the run's spec: its
   * contract is the spec's. Replayed and never superseded by an issue edit.
   */
  fromSpec: z.boolean().optional(),
  /**
   * A `ready` answer whose run left its slot to wait for runs working on the
   * same files. When the run comes back and one of them merged meanwhile, the
   * contract was written for code that changed: triage runs again. Cleared
   * once that was decided.
   */
  heldForPaths: z.boolean().optional(),
});
export type FactoryTriage = z.infer<typeof factoryTriageSchema>;

/** The run's contract, when triage wrote one. */
export const contractOf = (run: { triage: FactoryTriage | null }): FactoryContract | null =>
  run.triage?.decision === 'ready' ? (run.triage.contract ?? null) : null;
