/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: application-service
 * @domain layer: application
 *
 * Each user's issue factory for a project (change issue-factory): the on/off
 * (running / paused) toggle, the mode (manual: only the issues sent to it;
 * automatic: also the watched label, change factory-manual-queue), the flow to
 * run and the concurrency. Keyed per
 * `(project, user)` and scoped to project access: anyone who may start threads
 * on the project (`steer`) runs their own factory; a viewer may only read
 * theirs. Runs are stored separately (`factory-runs`).
 */
import {
  DEFAULT_FACTORY_BATCH,
  factoryStepOverridesSchema,
  MAX_SENSITIVE_PATHS,
  MERGE_STAGE,
  type FactoryAutoMerge,
  type FactoryBatchSettings,
  type FactoryMode,
  type FactoryStepOverrides,
} from '@funny/shared/contracts/factory';
import { parseStoredJson } from '@funny/shared/json-validation';
import { KNOWN_PROVIDER_IDS, providerModelProblem } from '@funny/shared/models';
import { and, eq, exists, inArray, or } from 'drizzle-orm';
import { errAsync, ResultAsync } from 'neverthrow';
import { z } from 'zod';

import { db } from '../../db/index.js';
import { factoryRuns, factorySettings, projects } from '../../db/schema.js';
import { requireProjectAccess } from '../project-access.js';
import { awaitsPullRequest } from './factory-runs.js';
import type { ProjectAgentDefaults } from './factory-step-options.js';

export interface FactorySettingsView {
  projectId: string;
  /** Running (true) or paused; separate from the mode. */
  enabled: boolean;
  mode: FactoryMode;
  label: string;
  flowName: string;
  maxConcurrent: number;
  /** Which reviewed changes the factory merges by itself. */
  autoMerge: FactoryAutoMerge;
  /** Globs that make a change high risk, besides the default list. */
  sensitivePaths: string[];
  /** Runs inside a flow node at once, per node id. */
  stageLimits: Record<string, number>;
  /** Provider / model / effort per agent step id, over the flow's own. */
  stepOverrides: FactoryStepOverrides;
  /** The merge queue's batch size and wait. */
  batch: FactoryBatchSettings;
  /** Why the factory cannot make progress now, or null. */
  blockedReason: string | null;
  updatedAt: string;
}

export type FactorySettingsError =
  | { kind: 'not-found'; message: string }
  /** The caller can see the project but their role does not allow this. */
  | { kind: 'forbidden'; message: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'storage'; message: string };

export interface SaveFactorySettingsInput {
  enabled: boolean;
  mode?: FactoryMode;
  label?: string;
  flowName?: string;
  maxConcurrent?: number;
  autoMerge?: FactoryAutoMerge;
  sensitivePaths?: string[];
  stageLimits?: Record<string, number>;
  stepOverrides?: FactoryStepOverrides;
  batch?: FactoryBatchSettings;
}

type Row = typeof factorySettings.$inferSelect;

/** The stored batch settings, or the defaults where a column is null. */
function batchOf(row: Row): FactoryBatchSettings {
  return {
    size: row.batchSize ?? DEFAULT_FACTORY_BATCH.size,
    waitSeconds:
      row.batchWaitMs === null
        ? DEFAULT_FACTORY_BATCH.waitSeconds
        : Math.round(row.batchWaitMs / 1000),
  };
}

const storage = (error: unknown): FactorySettingsError => ({
  kind: 'storage',
  message: error instanceof Error ? error.message : String(error),
});

const accessErrors = {
  storage,
  notFound: (): FactorySettingsError => ({ kind: 'not-found', message: 'Project not found' }),
  forbidden: (): FactorySettingsError => ({
    kind: 'forbidden',
    message: 'Running an issue factory needs contributor access to the project',
  }),
};

/** A stored mode; anything else reads as manual, which admits only what is sent. */
const modeOf = (row: Row): FactoryMode => (row.mode === 'automatic' ? 'automatic' : 'manual');

/** A stored policy; anything else reads as the careful one. */
const autoMergeOf = (row: Row): FactoryAutoMerge => (row.autoMerge === 'all' ? 'all' : 'low_risk');

const SENSITIVE_PATHS_SCHEMA = z.array(z.string());
const STAGE_LIMITS_SCHEMA = z.record(z.string(), z.number().int().positive());

function sensitivePathsOf(row: Row): string[] {
  if (!row.sensitivePaths) return [];
  const parsed = parseStoredJson(
    SENSITIVE_PATHS_SCHEMA,
    row.sensitivePaths,
    'factory_settings.sensitive_paths',
  );
  return parsed.ok ? parsed.value : [];
}

/** The stored limits, never one for `merge` (it is not tunable). */
function stageLimitsOf(row: Row): Record<string, number> {
  if (!row.stageLimits) return {};
  const parsed = parseStoredJson(
    STAGE_LIMITS_SCHEMA,
    row.stageLimits,
    'factory_settings.stage_limits',
  );
  if (!parsed.ok) return {};
  const { [MERGE_STAGE]: _merge, ...limits } = parsed.value;
  return limits;
}

/** The stored step overrides; a value that no longer parses reads as none. */
function stepOverridesOf(row: Row): FactoryStepOverrides {
  if (!row.stepOverrides) return {};
  const parsed = parseStoredJson(
    factoryStepOverridesSchema,
    row.stepOverrides,
    'factory_settings.step_overrides',
  );
  return parsed.ok ? parsed.value : {};
}

const toView = (row: Row): FactorySettingsView => ({
  projectId: row.projectId,
  enabled: row.enabled === 1,
  mode: modeOf(row),
  label: row.label,
  flowName: row.flowName,
  maxConcurrent: row.maxConcurrent,
  autoMerge: autoMergeOf(row),
  sensitivePaths: sensitivePathsOf(row),
  stageLimits: stageLimitsOf(row),
  stepOverrides: stepOverridesOf(row),
  batch: batchOf(row),
  blockedReason: row.blockedReason ?? null,
  updatedAt: row.updatedAt,
});

const byOwner = (userId: string, projectId: string) =>
  and(eq(factorySettings.projectId, projectId), eq(factorySettings.userId, userId));

function validate(input: SaveFactorySettingsInput): FactorySettingsError | null {
  if (input.label !== undefined && input.label.trim() === '') {
    return { kind: 'invalid', message: 'Label must not be empty' };
  }
  if (input.mode !== undefined && input.mode !== 'manual' && input.mode !== 'automatic') {
    return { kind: 'invalid', message: 'mode must be manual or automatic' };
  }
  if (input.maxConcurrent !== undefined && (input.maxConcurrent < 1 || input.maxConcurrent > 20)) {
    return { kind: 'invalid', message: 'maxConcurrent must be between 1 and 20' };
  }
  if (
    input.autoMerge !== undefined &&
    input.autoMerge !== 'low_risk' &&
    input.autoMerge !== 'all'
  ) {
    return { kind: 'invalid', message: 'autoMerge must be low_risk or all' };
  }
  if (input.sensitivePaths !== undefined && input.sensitivePaths.length > MAX_SENSITIVE_PATHS) {
    return { kind: 'invalid', message: `At most ${MAX_SENSITIVE_PATHS} sensitive paths` };
  }
  return validateStageLimits(input.stageLimits) ?? validateStepOverrides(input.stepOverrides);
}

/** Each override's provider is known and its model runs on it (the runtime's rule). */
function validateStepOverrides(
  overrides: FactoryStepOverrides | undefined,
): FactorySettingsError | null {
  if (overrides === undefined) return null;
  for (const [stepId, override] of Object.entries(overrides)) {
    if (override.provider && !KNOWN_PROVIDER_IDS.includes(override.provider)) {
      return {
        kind: 'invalid',
        message: `Step ${stepId}: unknown provider "${override.provider}"`,
      };
    }
    const problem = providerModelProblem(override.provider ?? 'claude', override.model);
    if (problem) return { kind: 'invalid', message: `Step ${stepId}: ${problem}` };
  }
  return null;
}

function validateStageLimits(
  limits: Record<string, number> | undefined,
): FactorySettingsError | null {
  if (limits === undefined) return null;
  if (MERGE_STAGE in limits) {
    return {
      kind: 'invalid',
      message: 'The merge limit cannot be changed: merges are one at a time per repository',
    };
  }
  const invalid = Object.values(limits).some(
    (limit) => !Number.isInteger(limit) || limit < 1 || limit > 20,
  );
  return invalid ? { kind: 'invalid', message: 'A stage limit must be between 1 and 20' } : null;
}

/** A new factory starts manual: it admits only the issues sent to it. */
const DEFAULTS = {
  mode: 'manual' as FactoryMode,
  label: 'ready-for-agent',
  flowName: 'issue-to-merge',
  maxConcurrent: 2,
  autoMerge: 'low_risk' as FactoryAutoMerge,
  sensitivePaths: [] as string[],
  stageLimits: {} as Record<string, number>,
  stepOverrides: {} as FactoryStepOverrides,
  batch: DEFAULT_FACTORY_BATCH,
};

/** The row to upsert, carrying forward the caller's existing values when a field is omitted. */
function buildRow(
  id: string,
  userId: string,
  projectId: string,
  input: SaveFactorySettingsInput,
  existing: FactorySettingsView | null,
): Row {
  const now = new Date().toISOString();
  const base = existing ?? DEFAULTS;
  return {
    id,
    projectId,
    userId,
    enabled: input.enabled ? 1 : 0,
    mode: input.mode ?? base.mode,
    label: input.label ?? base.label,
    flowName: input.flowName ?? base.flowName,
    maxConcurrent: input.maxConcurrent ?? base.maxConcurrent,
    autoMerge: input.autoMerge ?? base.autoMerge,
    sensitivePaths: JSON.stringify(input.sensitivePaths ?? base.sensitivePaths),
    stageLimits: JSON.stringify(input.stageLimits ?? base.stageLimits),
    stepOverrides: JSON.stringify(input.stepOverrides ?? base.stepOverrides),
    batchSize: (input.batch ?? base.batch).size,
    batchWaitMs: (input.batch ?? base.batch).waitSeconds * 1000,
    // A save is a new configuration: the watcher re-reports what still blocks it.
    blockedReason: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * A factory the watcher polls — server-internal, unscoped (like
 * `listAutomations`). A paused (disabled) factory is still polled while it has
 * runs in flight, so they run to completion; it admits nothing new.
 */
export interface WatchedFactory {
  id: string;
  enabled: boolean;
  /** `automatic` also admits labelled issues; `manual` only the queue. */
  mode: FactoryMode;
  projectId: string;
  userId: string;
  label: string;
  flowName: string;
  maxConcurrent: number;
  autoMerge: FactoryAutoMerge;
  sensitivePaths: string[];
  stageLimits: Record<string, number>;
  /** Provider / model / effort per agent step id (read again at every agent step). */
  stepOverrides: FactoryStepOverrides;
  /** The merge queue's batch size and wait. */
  batch: FactoryBatchSettings;
}

const toEnabled = (row: Row): WatchedFactory => ({
  id: row.id,
  enabled: row.enabled === 1,
  mode: modeOf(row),
  projectId: row.projectId,
  userId: row.userId,
  label: row.label,
  flowName: row.flowName,
  maxConcurrent: row.maxConcurrent,
  autoMerge: autoMergeOf(row),
  sensitivePaths: sensitivePathsOf(row),
  stageLimits: stageLimitsOf(row),
  stepOverrides: stepOverridesOf(row),
  batch: batchOf(row),
});

/**
 * Every enabled factory across all users/projects, for the watcher. Server-only
 * (no access check): the watcher acts as each factory's own enabling user.
 */
export async function listEnabledFactories(): Promise<WatchedFactory[]> {
  const rows = await db.select().from(factorySettings).where(eq(factorySettings.enabled, 1));
  return rows.map(toEnabled);
}

/** One factory by its id, enabled or paused, or null — the watcher re-reads it each tick. */
export async function getWatchedFactory(id: string): Promise<WatchedFactory | null> {
  const [row] = await db.select().from(factorySettings).where(eq(factorySettings.id, id));
  return row ? toEnabled(row) : null;
}

/**
 * Enabled factories plus paused ones with runs in flight or a parked run whose
 * pull request may still close: what the watcher polls at startup.
 */
export async function listWatchedFactories(inFlightStates: string[]): Promise<WatchedFactory[]> {
  const rows = await db
    .select()
    .from(factorySettings)
    .where(
      or(
        eq(factorySettings.enabled, 1),
        exists(
          db
            .select({ id: factoryRuns.id })
            .from(factoryRuns)
            .where(
              and(
                eq(factoryRuns.factoryId, factorySettings.id),
                inArray(factoryRuns.state, inFlightStates),
              ),
            ),
        ),
        // Paused, with a parked run a person may still merge or close.
        exists(
          db
            .select({ id: factoryRuns.id })
            .from(factoryRuns)
            .where(and(eq(factoryRuns.factoryId, factorySettings.id), awaitsPullRequest())),
        ),
      ),
    );
  return rows.map(toEnabled);
}

/** Record why a factory cannot make progress (null when it can) — the watcher's report. */
export async function setFactoryBlocked(id: string, reason: string | null): Promise<void> {
  await db.update(factorySettings).set({ blockedReason: reason }).where(eq(factorySettings.id, id));
}

/**
 * Turn a factory off from the server (no caller to authorize) — the watcher
 * does this when its enabler can no longer start threads on the project.
 */
export async function disableFactory(id: string): Promise<void> {
  await db
    .update(factorySettings)
    .set({ enabled: 0, updatedAt: new Date().toISOString() })
    .where(eq(factorySettings.id, id));
}

export function createFactorySettingsService(
  deps: { newId: () => string } = { newId: () => crypto.randomUUID() },
) {
  const find = (userId: string, projectId: string) =>
    ResultAsync.fromPromise(
      db.select().from(factorySettings).where(byOwner(userId, projectId)),
      storage,
    ).map(([row]) => (row ? toView(row) : null));

  /**
   * Insert the row, or on conflict change only the fields this save carries
   * (plus the toggle and the bookkeeping). An omitted field is never written
   * from an earlier read, so two saves in flight (the label and the mode)
   * cannot undo each other. The answer is the row as stored afterwards.
   */
  const upsert = (
    row: Row,
    input: SaveFactorySettingsInput,
  ): ResultAsync<FactorySettingsView, FactorySettingsError> => {
    const changes: Partial<Row> = {
      enabled: row.enabled,
      blockedReason: row.blockedReason,
      updatedAt: row.updatedAt,
      ...(input.mode !== undefined && { mode: row.mode }),
      ...(input.label !== undefined && { label: row.label }),
      ...(input.flowName !== undefined && { flowName: row.flowName }),
      ...(input.maxConcurrent !== undefined && { maxConcurrent: row.maxConcurrent }),
      ...(input.autoMerge !== undefined && { autoMerge: row.autoMerge }),
      ...(input.sensitivePaths !== undefined && { sensitivePaths: row.sensitivePaths }),
      ...(input.stageLimits !== undefined && { stageLimits: row.stageLimits }),
      ...(input.stepOverrides !== undefined && { stepOverrides: row.stepOverrides }),
      ...(input.batch !== undefined && { batchSize: row.batchSize, batchWaitMs: row.batchWaitMs }),
    };
    return ResultAsync.fromPromise(
      db
        .insert(factorySettings)
        .values(row)
        .onConflictDoUpdate({
          target: [factorySettings.projectId, factorySettings.userId],
          set: changes,
        }),
      storage,
    )
      .andThen(() => find(row.userId, row.projectId))
      .map((stored) => stored ?? toView(row));
  };

  return {
    get(
      userId: string,
      projectId: string,
    ): ResultAsync<FactorySettingsView | null, FactorySettingsError> {
      return requireProjectAccess(userId, projectId, 'view', accessErrors).andThen(() =>
        find(userId, projectId),
      );
    },

    /** The caller's factory row id for a project, or null — used to list its runs. */
    factoryId(userId: string, projectId: string): ResultAsync<string | null, FactorySettingsError> {
      return requireProjectAccess(userId, projectId, 'view', accessErrors).andThen(() =>
        ResultAsync.fromPromise(
          db
            .select({ id: factorySettings.id })
            .from(factorySettings)
            .where(byOwner(userId, projectId)),
          storage,
        ).map(([row]) => row?.id ?? null),
      );
    },

    save(
      userId: string,
      projectId: string,
      input: SaveFactorySettingsInput,
    ): ResultAsync<FactorySettingsView, FactorySettingsError> {
      const invalid = validate(input);
      if (invalid) return errAsync(invalid);
      // Enabling a factory starts agent threads on the project as this user,
      // so it needs the same capability as starting a thread by hand.
      return requireProjectAccess(userId, projectId, 'steer', accessErrors)
        .andThen(() => find(userId, projectId))
        .andThen((existing) =>
          upsert(buildRow(deps.newId(), userId, projectId, input, existing), input),
        );
    },
  };
}

/**
 * The project's agent defaults, under a flow's own (`resolveStepOptions`): what
 * a thread the factory starts without options would get from the runtime.
 */
export async function projectAgentDefaults(projectId: string): Promise<ProjectAgentDefaults> {
  const [row] = await db
    .select({
      provider: projects.defaultProvider,
      model: projects.defaultModel,
      effort: projects.defaultEffort,
    })
    .from(projects)
    .where(eq(projects.id, projectId));
  return row ?? {};
}
