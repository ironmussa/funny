/**
 * Typed fixtures and test doubles for runtime tests.
 *
 * Each builder fills every required field with a default so a test only names
 * the fields it cares about, and each fake implements the real interface, so a
 * test never has to cast a partial literal.
 */

import type { Project } from '@funny/shared';
import { expect, vi, type Mock } from 'vitest';

import type {
  IAgentExecutionProfileService,
  IAnalyticsService,
  IJobRepository,
  IMcpOauthService,
  IMessageQueueService,
  IPipelineRepository,
  IProfileService,
  IProjectRepository,
  ISearchService,
  IStageHistoryRepository,
  IStartupCommandsService,
  IThreadEventService,
  IThreadManager,
  IThreadRepository,
  IWatcherRepository,
  IWSBroker,
  RuntimeThreadRecord,
} from '../../services/server-interfaces.js';
import type { RuntimeServiceProvider } from '../../services/service-provider.js';

// ── Assertions ─────────────────────────────────────────────────

/** Asserts `value` is an instance of `type` and narrows it, instead of casting. */
export function expectInstance<T, V>(value: V, type: abstract new (...args: never[]) => T): T {
  expect(value).toBeInstanceOf(type);
  if (!(value instanceof type)) throw new Error(`expected an instance of ${type.name}`);
  return value;
}

// ── Global slots ───────────────────────────────────────────────

/** Properties production code keeps on `globalThis` across a hot reload. */
type HotReloadSlot = '__funnyActiveAgentSnapshot' | '__funnyActiveAgents';

/** The current value of a hot-reload slot (`undefined` when it is not set). */
export function readGlobal(key: HotReloadSlot): PropertyDescriptor['value'] {
  return Object.getOwnPropertyDescriptor(globalThis, key)?.value;
}

export function writeGlobal<V>(key: HotReloadSlot, value: V): void {
  Reflect.set(globalThis, key, value);
}

export function clearGlobal(key: HotReloadSlot): void {
  Reflect.deleteProperty(globalThis, key);
}

// ── Entity builders ────────────────────────────────────────────

export function buildProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'Project',
    path: '/tmp/project',
    userId: 'user-1',
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function buildThreadRecord(
  overrides: Partial<RuntimeThreadRecord> = {},
): RuntimeThreadRecord {
  return {
    id: 'thread-1',
    projectId: 'project-1',
    userId: 'user-1',
    sessionId: null,
    ...overrides,
  };
}

// ── Fakes ──────────────────────────────────────────────────────

export interface WsBrokerFake extends IWSBroker {
  emit: Mock<IWSBroker['emit']>;
  emitToUser: Mock<IWSBroker['emitToUser']>;
}

export function createWsBrokerFake(): WsBrokerFake {
  return { emit: vi.fn(), emitToUser: vi.fn() };
}

/** A thread manager whose every method is a `vi.fn()`; `overrides` replace any of them. */
export function createThreadManagerFake(overrides: Partial<IThreadManager> = {}): IThreadManager {
  return {
    getThread: vi.fn(),
    updateThread: vi.fn(),
    getThreadWithMessages: vi.fn(() => null),
    insertMessage: vi.fn(() => 'message-1'),
    updateMessage: vi.fn(),
    deleteMessagesAfter: vi.fn(async () => 0),
    insertToolCall: vi.fn(() => 'tool-call-1'),
    updateToolCallOutput: vi.fn(),
    findToolCall: vi.fn(),
    getToolCall: vi.fn(),
    ...overrides,
  };
}

function projectRepositoryFake(): IProjectRepository {
  return {
    listProjects: vi.fn(async () => []),
    listProjectsByOrg: vi.fn(async () => []),
    isProjectInOrg: vi.fn(async () => false),
    getProject: vi.fn(async () => undefined),
    projectNameExists: vi.fn(async () => false),
    createProject: vi.fn(),
    updateProject: vi.fn(),
    deleteProject: vi.fn(async () => {}),
    addProjectToOrg: vi.fn(async () => {}),
    getMemberLocalPath: vi.fn(async () => null),
    resolveProjectPath: vi.fn(),
    reorderProjects: vi.fn(),
  };
}

function threadRepositoryFake(): IThreadRepository {
  return {
    ...createThreadManagerFake(),
    listThreads: vi.fn(async () => ({ threads: [], total: 0 })),
    listArchivedThreads: vi.fn(async () => []),
    getThreadByExternalRequestId: vi.fn(async () => undefined),
    getThreadBySessionId: vi.fn(async () => undefined),
    createThread: vi.fn(async () => undefined),
    deleteThread: vi.fn(async () => {}),
    markStaleThreadsInterrupted: vi.fn(async () => {}),
    markStaleExternalThreadsStopped: vi.fn(async () => {}),
    markAndListStaleThreads: vi.fn(async () => []),
    getThreadMessages: vi.fn(async () => ({ messages: [], hasMore: false })),
    insertComment: vi.fn(async () => undefined),
    listComments: vi.fn(async () => []),
    deleteComment: vi.fn(async () => {}),
    getCommentCounts: vi.fn(async () => ({})),
    searchThreadIdsByContent: vi.fn(async () => new Map<string, string>()),
    findLastUnansweredInteractiveToolCall: vi.fn(async () => undefined),
  };
}

function pipelineRepositoryFake(): IPipelineRepository {
  return {
    getPipelineForProject: vi.fn(async () => null),
    createPipeline: vi.fn(async () => 'pipeline-1'),
    getPipelineById: vi.fn(async () => undefined),
    getPipelinesByProject: vi.fn(async () => []),
    updatePipeline: vi.fn(async () => {}),
    deletePipeline: vi.fn(async () => {}),
    createRun: vi.fn(async () => 'run-1'),
    updateRun: vi.fn(async () => {}),
    getRunById: vi.fn(async () => undefined),
    getRunsForThread: vi.fn(async () => []),
  };
}

function profileServiceFake(): IProfileService {
  return {
    getProfile: vi.fn(async () => null),
    getProviderKey: vi.fn(async () => null),
    getGithubToken: vi.fn(async () => null),
    getAssemblyaiApiKey: vi.fn(async () => null),
    getMinimaxApiKey: vi.fn(async () => null),
    getGitIdentity: vi.fn(async () => null),
    isSetupCompleted: vi.fn(async () => false),
    updateProfile: vi.fn(),
  };
}

function agentProfilesFake(): IAgentExecutionProfileService {
  return { resolveEffectiveProfile: vi.fn() };
}

function analyticsFake(): IAnalyticsService {
  return { getOverview: vi.fn(async () => ({})), getTimeline: vi.fn(async () => ({})) };
}

function searchFake(): ISearchService {
  return { searchThreadIdsByContent: vi.fn(async () => new Map<string, string>()) };
}

function startupCommandsFake(): IStartupCommandsService {
  return {
    listCommands: vi.fn(async () => []),
    createCommand: vi.fn(async () => undefined),
    updateCommand: vi.fn(async () => {}),
    deleteCommand: vi.fn(async () => {}),
    getCommand: vi.fn(async () => undefined),
  };
}

function threadEventsFake(): IThreadEventService {
  return {
    createThreadEvent: vi.fn(async () => {}),
    saveThreadEvent: vi.fn(async () => {}),
    getThreadEvents: vi.fn(async () => []),
    deleteThreadEvents: vi.fn(async () => {}),
  };
}

function messageQueueFake(): IMessageQueueService {
  return {
    enqueue: vi.fn(),
    peek: vi.fn(async () => null),
    dequeue: vi.fn(async () => null),
    cancel: vi.fn(async () => false),
    update: vi.fn(async () => null),
    listQueue: vi.fn(async () => []),
    queueCount: vi.fn(async () => 0),
    clearQueue: vi.fn(async () => {}),
  };
}

function mcpOauthFake(): IMcpOauthService {
  return { startOAuthFlow: vi.fn(), handleOAuthCallback: vi.fn(), upsertToken: vi.fn() };
}

function stageHistoryFake(): IStageHistoryRepository {
  return { recordStageChange: vi.fn(async () => {}) };
}

function watchersFake(): IWatcherRepository {
  return {
    insertWatcher: vi.fn(async () => {}),
    getWatcher: vi.fn(async () => undefined),
    getLiveWatcherByThreadKey: vi.fn(async () => undefined),
    listPendingWatchers: vi.fn(async () => []),
    listDueWatchers: vi.fn(async () => []),
    listWatchersByUser: vi.fn(async () => []),
    updateWatcher: vi.fn(async () => true),
    deleteWatchersByThread: vi.fn(async () => {}),
  };
}

function jobsFake(): IJobRepository {
  return {
    insertJob: vi.fn(async () => {}),
    getJob: vi.fn(async () => undefined),
    listRunningJobs: vi.fn(async () => []),
    listJobsByUser: vi.fn(async () => []),
    updateJob: vi.fn(async () => true),
    deleteJobsByThread: vi.fn(async () => {}),
  };
}

/** Per-service overrides: each one replaces only the methods it names. */
export type ServiceProviderOverrides = {
  [K in keyof RuntimeServiceProvider]?: Partial<RuntimeServiceProvider[K]>;
};

/**
 * A complete `RuntimeServiceProvider` whose every method is a `vi.fn()` with a
 * neutral result (empty list, `null`, `undefined`). Pass the methods a test
 * relies on in `overrides`.
 */
export function createServiceProviderFake(
  overrides: ServiceProviderOverrides = {},
): RuntimeServiceProvider {
  return {
    projects: { ...projectRepositoryFake(), ...overrides.projects },
    threads: { ...threadRepositoryFake(), ...overrides.threads },
    pipelines: { ...pipelineRepositoryFake(), ...overrides.pipelines },
    profile: { ...profileServiceFake(), ...overrides.profile },
    agentProfiles: { ...agentProfilesFake(), ...overrides.agentProfiles },
    analytics: { ...analyticsFake(), ...overrides.analytics },
    search: { ...searchFake(), ...overrides.search },
    startupCommands: { ...startupCommandsFake(), ...overrides.startupCommands },
    threadEvents: { ...threadEventsFake(), ...overrides.threadEvents },
    messageQueue: { ...messageQueueFake(), ...overrides.messageQueue },
    mcpOauth: { ...mcpOauthFake(), ...overrides.mcpOauth },
    stageHistory: { ...stageHistoryFake(), ...overrides.stageHistory },
    watchers: { ...watchersFake(), ...overrides.watchers },
    jobs: { ...jobsFake(), ...overrides.jobs },
    wsBroker: { ...createWsBrokerFake(), ...overrides.wsBroker },
  };
}
