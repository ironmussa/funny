import {
  DEFAULT_FACTORY_BATCH,
  DEFAULT_LANE_BRANCH_PREFIX,
  DEFAULT_LANE_LABEL_PREFIX,
  DEFAULT_MAX_LOW_RISK_LINES,
  factoryStepOverridesSchema,
  APPROVAL_ADJUST_LINES_RANGE,
  LOW_RISK_LINES_RANGE,
  MAX_SENSITIVE_PATHS,
  MAX_SIZE_IGNORED_PATHS,
  MERGE_STAGE,
  type FactoryAutoMerge,
  type FactoryBatchSettings,
  type FactoryDependencies,
  type FactoryMode,
  type FactorySettings,
  type FactoryStepOverrides,
  factoryBaseBranchSchema,
  factoryLaneBranchPrefixSchema,
  factoryLaneLabelPrefixSchema,
  type FactoryTooBig,
} from '@funny/shared/contracts/factory';
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
import { errorMessage } from '@funny/shared/errors';
import { parseStoredJson } from '@funny/shared/json-validation';
import { KNOWN_PROVIDER_IDS, providerModelProblem } from '@funny/shared/models';
import { and, eq, exists, inArray, notInArray, or } from 'drizzle-orm';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';
import { z } from 'zod';

import { db } from '../../db/index.js';
import { factoryLanes, factoryRuns, factorySettings, projects } from '../../db/schema.js';
import { requireProjectAccess } from '../project-access.js';
import { createFactoryLanesRepository, type FactoryLaneView } from './factory-lanes.js';
import { TERMINAL_STATES } from './factory-runs-model.js';
import { awaitsPullRequest } from './factory-runs.js';
import type { ProjectAgentDefaults } from './factory-step-options.js';

/** A factory's settings as the server reads them: the contract, without the incident it looks up apart. */
export type FactorySettingsView = Omit<FactorySettings, 'incident'>;

export type FactorySettingsError =
  | { kind: 'not-found'; message: string }
  /** The caller can see the project but their role does not allow this. */
  | { kind: 'forbidden'; message: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'storage'; message: string };

/** The settings a member configures (the contract's), without the toggle and the bookkeeping. */
type FactoryConfig = Omit<
  FactorySettings,
  'projectId' | 'enabled' | 'blockedReason' | 'incident' | 'updatedAt'
>;

/** A save: the toggle, and any configured field it changes (an omitted one keeps its value). */
export type SaveFactorySettingsInput = { enabled: boolean } & Partial<FactoryConfig>;

type Row = typeof factorySettings.$inferSelect;

/** How the factory treats an in-flight blocker: `wait` unless it stacks. */
const dependenciesOf = (row: Row): FactoryDependencies =>
  row.dependencies === 'stack' ? 'stack' : 'wait';

/** What the factory does with a too-large issue: `ask` unless it splits. */
const tooBigOf = (row: Row): FactoryTooBig => (row.tooBig === 'split' ? 'split' : 'ask');

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

const storage = (cause: unknown): FactorySettingsError => ({
  kind: 'storage',
  message: errorMessage(cause),
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

/** A stored JSON list of globs; a value that no longer parses reads as none. */
function globsOf(stored: string | null, column: string): string[] {
  if (!stored) return [];
  const parsed = parseStoredJson(SENSITIVE_PATHS_SCHEMA, stored, column);
  return parsed.ok ? parsed.value : [];
}

const sensitivePathsOf = (row: Row): string[] =>
  globsOf(row.sensitivePaths, 'factory_settings.sensitive_paths');

const sizeIgnoredPathsOf = (row: Row): string[] =>
  globsOf(row.sizeIgnoredPaths, 'factory_settings.size_ignored_paths');

/** The stored size limit, or the default where the column is null. */
const maxLowRiskLinesOf = (row: Row): number => row.maxLowRiskLines ?? DEFAULT_MAX_LOW_RISK_LINES;

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

/** The configured fields of a stored row, read with their fallbacks. */
const configOf = (row: Row): FactoryConfig => ({
  mode: modeOf(row),
  label: row.label,
  flowName: row.flowName,
  maxConcurrent: row.maxConcurrent,
  autoMerge: autoMergeOf(row),
  sensitivePaths: sensitivePathsOf(row),
  sizeGateEnabled: row.sizeGateEnabled === 1,
  maxLowRiskLines: maxLowRiskLinesOf(row),
  approvalAdjustMaxLines: row.approvalAdjustMaxLines ?? 0,
  sizeIgnoredPaths: sizeIgnoredPathsOf(row),
  stageLimits: stageLimitsOf(row),
  stepOverrides: stepOverridesOf(row),
  batch: batchOf(row),
  dependencies: dependenciesOf(row),
  tooBig: tooBigOf(row),
  holdPathsAwaitingApproval: row.holdPathsAwaitingApproval === 1,
  baseBranch: row.baseBranch ?? '',
  laneLabelPrefix: row.laneLabelPrefix ?? DEFAULT_LANE_LABEL_PREFIX,
  laneBranchPrefix: row.laneBranchPrefix ?? DEFAULT_LANE_BRANCH_PREFIX,
});

const toView = (row: Row): FactorySettingsView => ({
  projectId: row.projectId,
  enabled: row.enabled === 1,
  ...configOf(row),
  blockedReason: row.blockedReason ?? null,
  updatedAt: row.updatedAt,
});

const byOwner = (userId: string, projectId: string) =>
  and(eq(factorySettings.projectId, projectId), eq(factorySettings.userId, userId));

const outside = (value: number, min: number, max: number): boolean => value < min || value > max;

/** One check of a save: the problem's message, or null when the field is fine (or omitted). */
type SaveRule = (input: SaveFactorySettingsInput) => string | null;

const SAVE_RULES: readonly SaveRule[] = [
  ({ baseBranch }) =>
    baseBranch !== undefined && !factoryBaseBranchSchema.safeParse(baseBranch).success
      ? 'baseBranch is not a valid branch name'
      : null,
  ({ laneLabelPrefix }) =>
    laneLabelPrefix !== undefined &&
    !factoryLaneLabelPrefixSchema.safeParse(laneLabelPrefix).success
      ? 'laneLabelPrefix must be some text without spaces'
      : null,
  ({ laneBranchPrefix }) =>
    laneBranchPrefix !== undefined &&
    !factoryLaneBranchPrefixSchema.safeParse(laneBranchPrefix).success
      ? 'laneBranchPrefix is not the start of a valid branch name'
      : null,
  ({ label }) => (label !== undefined && label.trim() === '' ? 'Label must not be empty' : null),
  ({ mode }) =>
    mode !== undefined && mode !== 'manual' && mode !== 'automatic'
      ? 'mode must be manual or automatic'
      : null,
  ({ maxConcurrent }) =>
    maxConcurrent !== undefined && outside(maxConcurrent, 1, 20)
      ? 'maxConcurrent must be between 1 and 20'
      : null,
  ({ autoMerge }) =>
    autoMerge !== undefined && autoMerge !== 'low_risk' && autoMerge !== 'all'
      ? 'autoMerge must be low_risk or all'
      : null,
  ({ sensitivePaths }) =>
    (sensitivePaths?.length ?? 0) > MAX_SENSITIVE_PATHS
      ? `At most ${MAX_SENSITIVE_PATHS} sensitive paths`
      : null,
  ({ sizeIgnoredPaths }) =>
    (sizeIgnoredPaths?.length ?? 0) > MAX_SIZE_IGNORED_PATHS
      ? `At most ${MAX_SIZE_IGNORED_PATHS} paths left out of size`
      : null,
  ({ maxLowRiskLines: lines }) =>
    lines !== undefined &&
    (!Number.isInteger(lines) || outside(lines, LOW_RISK_LINES_RANGE.min, LOW_RISK_LINES_RANGE.max))
      ? `maxLowRiskLines must be between ${LOW_RISK_LINES_RANGE.min} and ${LOW_RISK_LINES_RANGE.max}`
      : null,
  ({ approvalAdjustMaxLines: lines }) =>
    lines !== undefined &&
    (!Number.isInteger(lines) ||
      outside(lines, APPROVAL_ADJUST_LINES_RANGE.min, APPROVAL_ADJUST_LINES_RANGE.max))
      ? `approvalAdjustMaxLines must be between ${APPROVAL_ADJUST_LINES_RANGE.min} and ${APPROVAL_ADJUST_LINES_RANGE.max}`
      : null,
];

function validate(input: SaveFactorySettingsInput): FactorySettingsError | null {
  for (const rule of SAVE_RULES) {
    const message = rule(input);
    if (message) return { kind: 'invalid', message };
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
const DEFAULTS: FactoryConfig = {
  mode: 'manual',
  label: 'ready-for-agent',
  flowName: 'issue-to-merge',
  maxConcurrent: 2,
  autoMerge: 'low_risk',
  sensitivePaths: [],
  sizeGateEnabled: false,
  maxLowRiskLines: DEFAULT_MAX_LOW_RISK_LINES,
  approvalAdjustMaxLines: 0,
  sizeIgnoredPaths: [],
  stageLimits: {},
  stepOverrides: {},
  batch: DEFAULT_FACTORY_BATCH,
  dependencies: 'wait',
  tooBig: 'ask',
  holdPathsAwaitingApproval: false,
  baseBranch: '',
  laneLabelPrefix: DEFAULT_LANE_LABEL_PREFIX,
  laneBranchPrefix: DEFAULT_LANE_BRANCH_PREFIX,
};

/** The configured fields a save stores: the ones it carries, else `base`'s. */
function mergeConfig(input: SaveFactorySettingsInput, base: FactoryConfig): FactoryConfig {
  const given: Partial<FactoryConfig> = input;
  const pick = <K extends keyof FactoryConfig>(key: K): FactoryConfig[K] => given[key] ?? base[key];
  return {
    mode: pick('mode'),
    label: pick('label'),
    flowName: pick('flowName'),
    maxConcurrent: pick('maxConcurrent'),
    autoMerge: pick('autoMerge'),
    sensitivePaths: pick('sensitivePaths'),
    sizeGateEnabled: pick('sizeGateEnabled'),
    maxLowRiskLines: pick('maxLowRiskLines'),
    approvalAdjustMaxLines: pick('approvalAdjustMaxLines'),
    sizeIgnoredPaths: pick('sizeIgnoredPaths'),
    stageLimits: pick('stageLimits'),
    stepOverrides: pick('stepOverrides'),
    batch: pick('batch'),
    dependencies: pick('dependencies'),
    tooBig: pick('tooBig'),
    holdPathsAwaitingApproval: pick('holdPathsAwaitingApproval'),
    baseBranch: pick('baseBranch').trim(),
    laneLabelPrefix: pick('laneLabelPrefix').trim(),
    laneBranchPrefix: pick('laneBranchPrefix').trim(),
  };
}

/** The row to upsert, carrying forward the caller's existing values when a field is omitted. */
function buildRow(
  id: string,
  userId: string,
  projectId: string,
  input: SaveFactorySettingsInput,
  existing: FactorySettingsView | null,
): Row {
  const now = new Date().toISOString();
  const config = mergeConfig(input, existing ?? DEFAULTS);
  return {
    id,
    projectId,
    userId,
    enabled: input.enabled ? 1 : 0,
    mode: config.mode,
    label: config.label,
    flowName: config.flowName,
    maxConcurrent: config.maxConcurrent,
    autoMerge: config.autoMerge,
    sensitivePaths: JSON.stringify(config.sensitivePaths),
    sizeGateEnabled: config.sizeGateEnabled ? 1 : 0,
    maxLowRiskLines: config.maxLowRiskLines,
    approvalAdjustMaxLines: config.approvalAdjustMaxLines,
    sizeIgnoredPaths: JSON.stringify(config.sizeIgnoredPaths),
    stageLimits: JSON.stringify(config.stageLimits),
    stepOverrides: JSON.stringify(config.stepOverrides),
    batchSize: config.batch.size,
    batchWaitMs: config.batch.waitSeconds * 1000,
    dependencies: config.dependencies,
    tooBig: config.tooBig,
    holdPathsAwaitingApproval: config.holdPathsAwaitingApproval ? 1 : 0,
    baseBranch: config.baseBranch || null,
    laneLabelPrefix: config.laneLabelPrefix,
    laneBranchPrefix: config.laneBranchPrefix,
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
export interface WatchedFactory extends FactoryConfig {
  id: string;
  enabled: boolean;
  projectId: string;
  userId: string;
}

const toEnabled = (row: Row): WatchedFactory => ({
  id: row.id,
  enabled: row.enabled === 1,
  projectId: row.projectId,
  userId: row.userId,
  ...configOf(row),
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

/** The columns each configured field is stored in. */
const COLUMNS_OF: Record<keyof FactoryConfig, readonly (keyof Row)[]> = {
  mode: ['mode'],
  label: ['label'],
  flowName: ['flowName'],
  maxConcurrent: ['maxConcurrent'],
  autoMerge: ['autoMerge'],
  sensitivePaths: ['sensitivePaths'],
  sizeGateEnabled: ['sizeGateEnabled'],
  maxLowRiskLines: ['maxLowRiskLines'],
  approvalAdjustMaxLines: ['approvalAdjustMaxLines'],
  sizeIgnoredPaths: ['sizeIgnoredPaths'],
  stageLimits: ['stageLimits'],
  stepOverrides: ['stepOverrides'],
  batch: ['batchSize', 'batchWaitMs'],
  dependencies: ['dependencies'],
  tooBig: ['tooBig'],
  holdPathsAwaitingApproval: ['holdPathsAwaitingApproval'],
  baseBranch: ['baseBranch'],
  laneLabelPrefix: ['laneLabelPrefix'],
  laneBranchPrefix: ['laneBranchPrefix'],
};

/** What a save writes over a stored row: the toggle, the bookkeeping and the fields it carries. */
function changedColumns(row: Row, input: SaveFactorySettingsInput): Partial<Row> {
  // SAFETY: COLUMNS_OF is typed Record<keyof FactoryConfig, …>, so its own keys are exactly
  // the FactoryConfig fields; Object.keys only widens them to string.
  const fields = (Object.keys(COLUMNS_OF) as (keyof FactoryConfig)[]).filter(
    (field) => input[field] !== undefined,
  );
  const carried = fields.flatMap((field) =>
    COLUMNS_OF[field].map((column) => [column, row[column]]),
  );
  return {
    enabled: row.enabled,
    blockedReason: row.blockedReason,
    updatedAt: row.updatedAt,
    // SAFETY: every entry of `carried` pairs a column (keyof Row) with row[column], the value
    // the same row holds under that key.
    ...(Object.fromEntries(carried) as Partial<Row>),
  };
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
    const changes = changedColumns(row, input);
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
        .andThen((existing) => lanesFix(userId, projectId, input, existing).map(() => existing))
        .andThen((existing) =>
          upsert(buildRow(deps.newId(), userId, projectId, input, existing), input),
        );
    },

    /** The lanes of the caller's factory for a project, oldest first (openspec factory-lanes). */
    lanes(userId: string, projectId: string): ResultAsync<FactoryLaneView[], FactorySettingsError> {
      return requireProjectAccess(userId, projectId, 'view', accessErrors)
        .andThen(() => ownFactoryId(userId, projectId))
        .andThen((factoryId) =>
          factoryId ? lanes.list(factoryId).mapErr(storageOf) : okAsync<FactoryLaneView[]>([]),
        );
    },

    /**
     * Remove a lane of the caller's factory: its row only, its branch is left
     * on GitHub. Refused while a run of the lane has not ended or its sync is
     * in flight: both still write to the lane's branch.
     */
    removeLane(
      userId: string,
      projectId: string,
      name: string,
    ): ResultAsync<void, FactorySettingsError> {
      return requireProjectAccess(userId, projectId, 'steer', accessErrors)
        .andThen(() => ownFactoryId(userId, projectId))
        .andThen((factoryId) =>
          factoryId
            ? lanes.find(factoryId, name.trim().toLowerCase()).mapErr(storageOf)
            : okAsync<FactoryLaneView | null>(null),
        )
        .andThen((lane) => {
          if (!lane) return errAsync<void, FactorySettingsError>(NO_SUCH_LANE);
          if (SYNC_IN_FLIGHT.has(lane.syncState)) {
            return errAsync<void, FactorySettingsError>({
              kind: 'invalid',
              message: `The lane ${lane.name} is being synced: remove it when the sync ends`,
            });
          }
          return openRunsOfLane(lane).andThen((open) =>
            open.length > 0
              ? errAsync<void, FactorySettingsError>({
                  kind: 'invalid',
                  message: `The lane ${lane.name} still has runs that have not ended (${open.join(', ')}): stop or finish them first`,
                })
              : lanes
                  .remove(lane.id)
                  .mapErr(storageOf)
                  .map(() => undefined),
          );
        });
    },
  };
}

const lanes = createFactoryLanesRepository();

const NO_SUCH_LANE: FactorySettingsError = { kind: 'not-found', message: 'Lane not found' };

/** Sync states in which the factory is writing to the lane's branch. */
const SYNC_IN_FLIGHT: ReadonlySet<string> = new Set(['merging', 'resolving', 'checking']);

const storageOf = (error: { message: string }): FactorySettingsError => ({
  kind: 'storage',
  message: error.message,
});

const ownFactoryId = (
  userId: string,
  projectId: string,
): ResultAsync<string | null, FactorySettingsError> =>
  ResultAsync.fromPromise(
    db.select({ id: factorySettings.id }).from(factorySettings).where(byOwner(userId, projectId)),
    storage,
  ).map(([row]) => row?.id ?? null);

/** The runs admitted to a lane that have not ended, named as the board names them. */
const openRunsOfLane = (lane: FactoryLaneView): ResultAsync<string[], FactorySettingsError> =>
  ResultAsync.fromPromise(
    db
      .select({ id: factoryRuns.id, issueNumber: factoryRuns.issueNumber })
      .from(factoryRuns)
      .where(
        and(
          eq(factoryRuns.factoryId, lane.factoryId),
          eq(factoryRuns.lane, lane.name),
          notInArray(factoryRuns.state, [...TERMINAL_STATES]),
        ),
      ),
    storage,
  ).map((rows) =>
    rows.map((row) => (row.issueNumber > 0 ? `#${row.issueNumber}` : `run-${row.id.slice(0, 8)}`)),
  );

/** The settings every lane of a factory was made with: fixed while it has lanes. */
const LANE_FIXED_FIELDS = ['baseBranch', 'laneLabelPrefix', 'laneBranchPrefix'] as const;

/**
 * Refuse a save that changes what the factory's lanes were made with (openspec
 * factory-lanes, D1): each lane's branch was cut from the "merge into" branch
 * and is kept in sync with it, and its name comes from the two prefixes.
 */
function lanesFix(
  userId: string,
  projectId: string,
  input: SaveFactorySettingsInput,
  existing: FactorySettingsView | null,
): ResultAsync<void, FactorySettingsError> {
  const changed = LANE_FIXED_FIELDS.filter(
    (field) => input[field] !== undefined && existing && input[field]!.trim() !== existing[field],
  );
  if (!existing || changed.length === 0) return okAsync(undefined);
  return ResultAsync.fromPromise(
    db
      .select({ name: factoryLanes.name })
      .from(factoryLanes)
      .innerJoin(factorySettings, eq(factoryLanes.factoryId, factorySettings.id))
      .where(byOwner(userId, projectId)),
    storage,
  ).andThen((lanes) =>
    lanes.length === 0
      ? okAsync(undefined)
      : errAsync<void, FactorySettingsError>({
          kind: 'invalid',
          message: `${changed.join(', ')} cannot change while the factory has lanes (${lanes
            .map((lane) => lane.name)
            .join(', ')}): finish or remove them first`,
        }),
  );
}

/**
 * The branch a factory merges into, as its enabler configured it, or null for
 * the repository's default branch (or no factory). Server-internal: the
 * factory's GitHub side reads it for the enabler it acts as.
 */
export async function factoryBaseBranchOf(
  userId: string,
  projectId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ baseBranch: factorySettings.baseBranch })
    .from(factorySettings)
    .where(byOwner(userId, projectId));
  return row?.baseBranch || null;
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
