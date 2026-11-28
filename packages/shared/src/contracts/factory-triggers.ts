/**
 * Contracts for the factory's schedule triggers and issueless runs
 * (change flow-triggers). Re-exported from `factory.ts`.
 */

import { z } from 'zod';

const projectId = z.string().min(1);
/** Named like a workflow file; see `flowName` in `factory.ts`. */
const flowName = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9][a-z0-9._-]{0,63}$/,
    'Flow names use lowercase letters, digits, ".", "_" and "-"',
  );

/**
 * Triggers (change flow-triggers): what starts a flow of the caller's factory
 * besides an issue. A schedule trigger starts its flow at each occurrence of a
 * cron pattern; its runs have no issue and get the trigger's input values.
 */

/** At most this many schedule triggers per factory. */
export const MAX_FACTORY_TRIGGERS = 20;

/** At most this many input values on a trigger or a "run a flow" start. */
export const MAX_TRIGGER_INPUTS = 20;

const triggerInputs = z
  .record(
    z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, {
      message: 'An input name is lowercase letters, digits and underscores, starting with a letter',
    }),
    z.string().max(4000),
  )
  .refine((inputs) => Object.keys(inputs).length <= MAX_TRIGGER_INPUTS, {
    message: `At most ${MAX_TRIGGER_INPUTS} inputs`,
  });

export interface FactoryTrigger {
  id: string;
  name: string;
  /** A cron pattern, in the server's time zone. */
  schedule: string;
  flowName: string;
  /** The input values each run gets. Shown to every member who sees the factory: no secrets. */
  inputs: Record<string, string>;
  enabled: boolean;
  /** The next occurrence; null while disabled. */
  nextRunAt: string | null;
}

/** Create a schedule trigger, or change the one with `id`. */
export const saveFactoryTriggerInput = z
  .object({
    projectId,
    id: z.string().min(1).optional(),
    name: z.string().trim().min(1).max(80),
    schedule: z.string().trim().min(1).max(120),
    flowName,
    inputs: triggerInputs.default({}),
    enabled: z.boolean().default(true),
  })
  .strict();

export type SaveFactoryTriggerInput = z.input<typeof saveFactoryTriggerInput>;

export const factoryTriggerInput = z.object({ projectId, triggerId: z.string().min(1) }).strict();

/** Start one run of a flow now, without an issue, with typed input values. */
export const runFactoryFlowInput = z
  .object({ projectId, flowName, inputs: triggerInputs.default({}) })
  .strict();

export type RunFactoryFlowInput = z.input<typeof runFactoryFlowInput>;

/** One input a flow declares and the factory does not supply itself. */
export interface FactoryFlowInput {
  name: string;
  required: boolean;
  description: string | null;
}
