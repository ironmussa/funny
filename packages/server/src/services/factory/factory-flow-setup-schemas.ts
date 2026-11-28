/**
 * Schemas of the factory flow setup's stored JSON columns, and the one mapping
 * from the runner's verification answer to the contract's verdict shape
 * (openspec `factory-flow-bootstrap`). Every read of a `factory_flow_setups`
 * JSON column goes through `parseSetupColumn`.
 */

import { testStackFactsSchema } from '@funny/core';
import type {
  FactoryFlowSetupRuleCheckRun,
  FactoryFlowSetupRuleVerdict,
} from '@funny/shared/contracts/factory';
import { parseStoredJson } from '@funny/shared/json-validation';
import type { verifyFlowSetupResultSchema } from '@ironmussa/funny-runtime/validation/schemas';
import { z } from 'zod';

const checkRunSchema = z.object({
  command: z.string(),
  files: z.array(z.string()),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  aborted: z.boolean(),
  output: z.string(),
}) satisfies z.ZodType<FactoryFlowSetupRuleCheckRun>;

const ruleVerdictSchema = z.object({
  ruleIndex: z.number().int().min(0),
  globs: z.array(z.string()),
  command: z.string(),
  cwd: z.string().optional(),
  accepted: z.boolean(),
  rejectionReason: z.string().optional(),
  passingCanary: checkRunSchema.optional(),
  failingCanary: checkRunSchema.optional(),
  existingTest: checkRunSchema.optional(),
  twoFileRun: checkRunSchema.optional(),
}) satisfies z.ZodType<FactoryFlowSetupRuleVerdict>;

const uncoveredSchema = z.object({ scope: z.string(), reason: z.string() });

export const storedVerdictsSchema = z.object({
  setupOutput: z.string().optional(),
  rules: z.array(ruleVerdictSchema),
  uncovered: z.array(uncoveredSchema),
  timedOut: z.boolean(),
});

export const storedPromptFilesSchema = z.array(
  z.object({ path: z.string().min(1), content: z.string() }),
);

/** What `startFlowSetup` stores: the runner's facts, or why it could not detect them. */
export const storedFactsSchema = z.union([
  testStackFactsSchema,
  z.object({ recognized: z.literal(false), error: z.string() }),
]);

export type StoredSetupFacts = z.infer<typeof storedFactsSchema>;

/** Parse a stored JSON column; null when empty or not the expected shape. */
export function parseSetupColumn<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  raw: string | null,
  column: string,
): z.infer<TSchema> | null {
  if (!raw) return null;
  const parsed = parseStoredJson(schema, raw, `factory_flow_setups.${column}`);
  return parsed.ok ? parsed.value : null;
}

/** The runner's verification answer (`runtime/services/factory-flow-setup-verify.ts`). */
export type RunnerVerifyResult = z.infer<typeof verifyFlowSetupResultSchema>;
type RunnerCheckRun = NonNullable<RunnerVerifyResult['verdicts'][number]['passingRun']>;

export interface VerifyFlowSetupResult {
  /** The runner's explanation when the job failed as a whole. */
  finding?: string;
  setupOutput?: string;
  rules: FactoryFlowSetupRuleVerdict[];
  acceptedCount: number;
  rejectedCount: number;
  prunedWorkflowYaml: string | null;
  timedOut: boolean;
}

function toCheckRun(run: RunnerCheckRun | undefined): FactoryFlowSetupRuleCheckRun | undefined {
  if (!run) return undefined;
  const { outputTail, ...rest } = run;
  return { ...rest, output: outputTail };
}

function toRuleVerdict(
  verdict: RunnerVerifyResult['verdicts'][number],
): FactoryFlowSetupRuleVerdict {
  const mapped: FactoryFlowSetupRuleVerdict = {
    ruleIndex: verdict.ruleIndex,
    globs: verdict.globs,
    command: verdict.command,
    accepted: verdict.accepted,
  };
  if (verdict.cwd) mapped.cwd = verdict.cwd;
  if (verdict.reason) mapped.rejectionReason = verdict.reason;
  const passingCanary = toCheckRun(verdict.passingRun);
  if (passingCanary) mapped.passingCanary = passingCanary;
  const failingCanary = toCheckRun(verdict.failingRun);
  if (failingCanary) mapped.failingCanary = failingCanary;
  const existingTest = toCheckRun(verdict.existingRun);
  if (existingTest) mapped.existingTest = existingTest;
  const twoFileRun = toCheckRun(verdict.twoFileRun);
  if (twoFileRun) mapped.twoFileRun = twoFileRun;
  return mapped;
}

/** Map the runner's verification answer to the shape the server stores and the browser shows. */
export function toVerifyFlowSetupResult(result: RunnerVerifyResult): VerifyFlowSetupResult {
  const mapped: VerifyFlowSetupResult = {
    rules: result.verdicts.map(toRuleVerdict),
    acceptedCount: result.acceptedCount,
    rejectedCount: result.rejectedCount,
    prunedWorkflowYaml: result.ok ? result.prunedYaml : null,
    timedOut: result.failureReason === 'timed-out',
  };
  if (result.finding) mapped.finding = result.finding;
  if (result.setupOutputTail) mapped.setupOutput = result.setupOutputTail;
  return mapped;
}
