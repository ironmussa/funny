/**
 * @domain subdomain: Shared Kernel
 * @domain type: port
 * @domain layer: domain
 *
 * Aggregates all service interfaces that the runtime depends on.
 *
 * The runtime accesses data exclusively through this provider — it never
 * imports DB modules directly. The concrete implementation
 * (`runner-service-provider.ts`) proxies all operations over the
 * WebSocket tunnel to the central server.
 */

import type {
  IProjectRepository,
  IThreadRepository,
  IAutomationRepository,
  IPipelineRepository,
  IProfileService,
  IAnalyticsService,
  ISearchService,
  IStartupCommandsService,
  IThreadEventService,
  IMessageQueueService,
  IMcpOauthService,
  IStageHistoryRepository,
  IArcRepository,
  IWSBroker,
} from './server-interfaces.js';

export interface RuntimeServiceProvider {
  /** Project CRUD + org associations */
  projects: IProjectRepository;
  /** Thread CRUD, messages, tool calls, comments, search */
  threads: IThreadRepository;
  /** Automation CRUD + run tracking */
  automations: IAutomationRepository;
  /** Pipeline CRUD + run tracking */
  pipelines: IPipelineRepository;
  /** User profile, git identity, GitHub tokens */
  profile: IProfileService;
  /** Overview and timeline analytics */
  analytics: IAnalyticsService;
  /** Full-text search across thread messages */
  search: ISearchService;
  /** Project startup commands CRUD */
  startupCommands: IStartupCommandsService;
  /** Thread event persistence (git operations, status changes) */
  threadEvents: IThreadEventService;
  /** Queued follow-up messages */
  messageQueue: IMessageQueueService;
  /** MCP OAuth token storage and flow */
  mcpOauth: IMcpOauthService;
  /** Git stage change tracking */
  stageHistory: IStageHistoryRepository;
  /** Arc lookup for agent context injection */
  arcs?: IArcRepository;
  /** WebSocket event broadcasting */
  wsBroker: IWSBroker;
}
