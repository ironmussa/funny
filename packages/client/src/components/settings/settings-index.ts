/**
 * Static index of the settings UI (openspec `settings-filter`).
 *
 * Settings pages are only mounted while open, so the sidebar filter cannot read
 * their DOM: it matches against this list instead. Each entry describes one
 * static element of a page — a setting row or a section header — never user
 * data (installed servers, members, runners…).
 *
 * Keeping it honest:
 * - `SettingId` is the union of the ids below, and the row / section
 *   primitives take a `settingId: SettingId`, so a rendered id that is not
 *   listed here fails typecheck.
 * - `scripts/fitness/check-settings-index.ts` (in `bun run lint`) fails when an
 *   id listed here is not rendered anywhere.
 *
 * `title` / `description` are i18n keys or literal English text; `*Default`
 * is the fallback the page itself passes to `t()` when the key is not in the
 * locale files yet. Pages with no indexed elements can still be found through
 * `SETTINGS_PAGE_KEYWORDS`.
 */
import { PROVIDER_KEY_REGISTRY } from '@funny/shared/models';

export type SettingsScope = 'preferences' | 'project';

export interface SettingsIndexEntry {
  readonly id: string;
  readonly scope: SettingsScope;
  /** Page id: a `GeneralPage` for preferences, a `SettingsItemId` for project. */
  readonly page: string;
  readonly kind: 'row' | 'section';
  readonly title: string;
  readonly titleDefault?: string;
  readonly description?: string;
  readonly descriptionDefault?: string;
  /** Extra search terms (synonyms, other languages, related control names). */
  readonly keywords?: readonly string[];
}

const AI_PROVIDER_LABELS = PROVIDER_KEY_REGISTRY.filter(
  (k) => k.id !== 'github' && k.id !== 'assemblyai',
).map((k) => k.label);

const ENTRIES = [
  // ── Preferences › General ─────────────────────────────────────────────
  {
    id: 'general.default-editor',
    scope: 'preferences',
    page: 'general',
    kind: 'row',
    title: 'settings.defaultEditor',
    description: 'settings.defaultEditorDesc',
    keywords: ['vscode', 'cursor', 'ide'],
  },
  {
    id: 'general.internal-editor',
    scope: 'preferences',
    page: 'general',
    kind: 'row',
    title: 'settings.useInternalEditor',
    description: 'settings.useInternalEditorDesc',
    keywords: ['monaco'],
  },
  {
    id: 'general.language',
    scope: 'preferences',
    page: 'general',
    kind: 'row',
    title: 'settings.language',
    description: 'settings.languageDesc',
    keywords: ['idioma', 'i18n', 'english', 'español', 'português'],
  },
  {
    id: 'general.terminal-shell',
    scope: 'preferences',
    page: 'general',
    kind: 'row',
    title: 'settings.terminalShell',
    description: 'settings.terminalShellDesc',
    keywords: ['bash', 'zsh', 'powershell', 'terminal'],
  },
  {
    id: 'general.notifications',
    scope: 'preferences',
    page: 'general',
    kind: 'row',
    title: 'settings.notifications',
    description: 'settings.notificationsDesc',
    keywords: ['push', 'alerts', 'notificaciones'],
  },
  {
    id: 'general.notifications-sound',
    scope: 'preferences',
    page: 'general',
    kind: 'row',
    title: 'settings.notificationsSound',
    description: 'settings.notificationsSoundDesc',
    keywords: ['sound', 'audio', 'sonido'],
  },

  // ── Preferences › Models ──────────────────────────────────────────────
  {
    id: 'models.utility-model',
    scope: 'preferences',
    page: 'models',
    kind: 'section',
    title: 'settings.utilityModel',
    description: 'settings.utilityModelDesc',
    keywords: ['utility', 'helper', 'recap', 'summary', 'resumen', 'commit message', 'haiku'],
  },
  {
    id: 'models.thread-recap',
    scope: 'preferences',
    page: 'models',
    kind: 'row',
    title: 'settings.threadRecap',
    description: 'settings.threadRecapDesc',
    keywords: ['recap', 'summary', 'resumen', 'resumo', 'away', 'catch up'],
  },
  {
    id: 'models.utility-model-provider',
    scope: 'preferences',
    page: 'models',
    kind: 'row',
    title: 'settings.utilityModelProvider',
    description: 'settings.utilityModelProviderDesc',
    keywords: ['utility model', 'recap', 'summary', 'resumen', 'openai', 'ollama', 'anthropic'],
  },
  {
    id: 'models.utility-model-name',
    scope: 'preferences',
    page: 'models',
    kind: 'row',
    title: 'settings.utilityModelName',
    description: 'settings.utilityModelNameDesc',
    keywords: ['utility model', 'recap', 'summary', 'resumen', 'haiku'],
  },
  {
    id: 'models.utility-model-base-url',
    scope: 'preferences',
    page: 'models',
    kind: 'row',
    title: 'settings.utilityModelBaseUrl',
    description: 'settings.utilityModelBaseUrlDesc',
    keywords: ['utility model', 'endpoint', 'openai-compatible', 'url'],
  },

  // ── Preferences › Appearance ──────────────────────────────────────────
  {
    id: 'appearance.theme',
    scope: 'preferences',
    page: 'appearance',
    kind: 'row',
    title: 'settings.theme',
    description: 'settings.themeDesc',
    keywords: ['dark', 'light', 'color', 'tema', 'oscuro', 'claro'],
  },
  {
    id: 'appearance.font-size',
    scope: 'preferences',
    page: 'appearance',
    kind: 'row',
    title: 'settings.fontSize',
    description: 'settings.fontSizeDesc',
    keywords: ['font', 'text size', 'zoom', 'tamaño', 'letra', 'fuente'],
  },
  {
    id: 'appearance.experimental',
    scope: 'preferences',
    page: 'appearance',
    kind: 'section',
    title: 'settings.experimental',
    titleDefault: 'Experimental',
  },
  {
    id: 'appearance.thread-viewer',
    scope: 'preferences',
    page: 'appearance',
    kind: 'row',
    title: 'settings.threadViewer',
    titleDefault: 'Thread viewer',
    description: 'settings.threadViewerDesc',
    descriptionDefault:
      'Frozen renders messages in normal document flow (native scroll, find-in-page across the whole thread). Virtual is the current renderer.',
    keywords: ['frozen', 'virtual', 'renderer'],
  },

  // ── Preferences › GitHub / AI keys / Speech ───────────────────────────
  {
    id: 'github.token',
    scope: 'preferences',
    page: 'github',
    kind: 'row',
    title: 'profile.githubTokenLabel',
    description: 'profile.githubTokenDesc',
    keywords: ['pat', 'gh', 'personal access token'],
  },
  {
    id: 'ai-keys.provider-keys',
    scope: 'preferences',
    page: 'ai-keys',
    kind: 'section',
    title: 'API keys',
    description: 'Configure API keys for AI providers. Keys are encrypted at rest.',
    keywords: AI_PROVIDER_LABELS,
  },
  {
    id: 'speech.assemblyai',
    scope: 'preferences',
    page: 'speech',
    kind: 'row',
    title: 'AssemblyAI API Key',
    description: 'Configure an AssemblyAI API key to enable voice dictation in the prompt input.',
    keywords: ['voice', 'dictation', 'dictado', 'voz', 'microphone'],
  },

  // ── Preferences › Organizations / Team members ────────────────────────
  {
    id: 'organizations.create',
    scope: 'preferences',
    page: 'organizations',
    kind: 'section',
    title: 'Create Organization',
  },
  {
    id: 'organizations.list',
    scope: 'preferences',
    page: 'organizations',
    kind: 'section',
    title: 'Your Organizations',
  },
  {
    id: 'team-members.invite',
    scope: 'preferences',
    page: 'team-members',
    kind: 'section',
    title: 'Invite Member',
    keywords: ['invitation', 'invitar'],
  },
  {
    id: 'team-members.invite-link',
    scope: 'preferences',
    page: 'team-members',
    kind: 'section',
    title: 'Invite Link',
  },
  {
    id: 'team-members.members',
    scope: 'preferences',
    page: 'team-members',
    kind: 'section',
    title: 'Members',
    keywords: ['miembros'],
  },
  {
    id: 'team-members.pending',
    scope: 'preferences',
    page: 'team-members',
    kind: 'section',
    title: 'Pending Invitations',
  },

  // ── Preferences › System ──────────────────────────────────────────────
  {
    id: 'system.native-git',
    scope: 'preferences',
    page: 'system',
    kind: 'row',
    title: 'Native Git (gitoxide)',
    description:
      'Rust-based git implementation for faster status, diff, log, and branch operations.',
    keywords: ['gix', 'rust'],
  },
  {
    id: 'system.build',
    scope: 'preferences',
    page: 'system',
    kind: 'row',
    title: 'Build',
    description: 'The commit this build was made from.',
    keywords: ['version', 'commit', 'sha', 'versión'],
  },

  // ── Project › General ─────────────────────────────────────────────────
  {
    id: 'project-general.path',
    scope: 'project',
    page: 'general',
    kind: 'row',
    title: 'settings.projectPath',
    titleDefault: 'Project Path',
    description: 'settings.projectPathDesc',
    descriptionDefault: 'Absolute path to the git repository.',
    keywords: ['directory', 'folder', 'ruta'],
  },
  {
    id: 'project-general.color',
    scope: 'project',
    page: 'general',
    kind: 'row',
    title: 'Project Color',
    description: 'Pick any color for this project',
    keywords: ['colour', 'color'],
  },
  {
    id: 'project-general.follow-up-mode',
    scope: 'project',
    page: 'general',
    kind: 'row',
    title: 'settings.followUpMode',
    description: 'settings.followUpModeDesc',
    keywords: ['interrupt', 'queue', 'steer'],
  },
  {
    id: 'project-general.fast-mode',
    scope: 'project',
    page: 'general',
    kind: 'row',
    title: 'settings.fastMode',
    description: 'settings.fastModeDesc',
  },
  {
    id: 'project-general.redirect-checks',
    scope: 'project',
    page: 'general',
    kind: 'row',
    title: 'settings.redirectChecks',
    description: 'settings.redirectChecksDesc',
  },
  {
    id: 'project-general.default-model',
    scope: 'project',
    page: 'general',
    kind: 'row',
    title: 'settings.projectDefaultModel',
    titleDefault: 'Default Model',
    description: 'settings.projectDefaultModelDesc',
    descriptionDefault: 'Provider and model for new threads in this project',
    keywords: ['provider', 'modelo', 'claude', 'codex', 'gemini'],
  },
  {
    id: 'project-general.default-effort',
    scope: 'project',
    page: 'general',
    kind: 'row',
    title: 'settings.projectDefaultEffort',
    description: 'settings.projectDefaultEffortDesc',
    keywords: ['reasoning', 'thinking', 'esfuerzo'],
  },
  {
    id: 'project-general.thread-mode',
    scope: 'project',
    page: 'general',
    kind: 'row',
    title: 'settings.projectDefaultMode',
    titleDefault: 'Default Thread Mode',
    keywords: ['worktree', 'local'],
  },
  {
    id: 'project-general.permission-mode',
    scope: 'project',
    page: 'general',
    kind: 'row',
    title: 'settings.projectDefaultPermission',
    titleDefault: 'Default Permission Mode',
    description: 'settings.projectDefaultPermissionDesc',
    descriptionDefault: 'Permission mode for new threads',
    keywords: ['plan', 'ask', 'auto edit', 'permisos'],
  },
  {
    id: 'project-general.default-branch',
    scope: 'project',
    page: 'general',
    kind: 'row',
    title: 'settings.projectDefaultBranch',
    titleDefault: 'Default Branch',
    description: 'settings.projectDefaultBranchDesc',
    descriptionDefault: 'Branch pre-selected when creating new threads',
    keywords: ['rama', 'git'],
  },
  {
    id: 'project-general.urls',
    scope: 'project',
    page: 'general',
    kind: 'row',
    title: 'settings.projectUrls',
    titleDefault: 'Extension URLs',
    description: 'settings.projectUrlsDesc',
    descriptionDefault: 'URLs for Chrome extension auto-detection.',
    keywords: ['chrome'],
  },
  {
    id: 'project-general.system-prompt',
    scope: 'project',
    page: 'general',
    kind: 'row',
    title: 'settings.systemPrompt',
    titleDefault: 'System Prompt',
    description: 'settings.systemPromptDesc',
    descriptionDefault: 'Custom instructions prepended to every agent message in this project.',
    keywords: ['instructions', 'instrucciones', 'conventions'],
  },
  {
    id: 'project-general.launcher-url',
    scope: 'project',
    page: 'general',
    kind: 'row',
    title: 'settings.launcherUrl',
    titleDefault: 'Podman Launcher URL',
    description: 'settings.launcherUrlDesc',
    descriptionDefault: 'URL of the Podman launcher API for remote container execution',
    keywords: ['container'],
  },
  {
    id: 'project-general.weave',
    scope: 'project',
    page: 'general',
    kind: 'row',
    title: 'settings.weaveTitle',
    titleDefault: 'Semantic Merge (Weave)',
    description: 'settings.weaveDesc',
    descriptionDefault: 'Reduces false merge conflicts using semantic analysis',
    keywords: ['conflicts', 'conflictos'],
  },
  {
    id: 'project-general.sandbox',
    scope: 'project',
    page: 'general',
    kind: 'row',
    title: 'settings.projectSandbox',
    titleDefault: 'Sandbox',
  },
  {
    id: 'project-general.sandbox-size',
    scope: 'project',
    page: 'general',
    kind: 'row',
    title: 'settings.projectSandboxSize',
    titleDefault: 'Sandbox size',
    description: 'settings.projectSandboxSizeDesc',
    descriptionDefault: 'Machine size for new sandboxes',
  },
  {
    id: 'project-general.default-template',
    scope: 'project',
    page: 'general',
    kind: 'row',
    title: 'Default Agent Template',
    description: 'Auto-select this template when creating new Deep Agent threads in this project.',
  },
  {
    id: 'project-general.permissions',
    scope: 'project',
    page: 'general',
    kind: 'section',
    title: 'settings.permissions',
  },
  {
    id: 'project-general.tool-permissions',
    scope: 'project',
    page: 'general',
    kind: 'row',
    title: 'settings.toolPermissions',
    description: 'settings.toolPermissionsDesc',
    keywords: ['bash', 'edit', 'write', 'allow', 'deny', 'herramientas'],
  },

  // ── Project › MCP server ──────────────────────────────────────────────
  {
    id: 'mcp-server.installed',
    scope: 'project',
    page: 'mcp-server',
    kind: 'section',
    title: 'mcp.installedServers',
  },
  {
    id: 'mcp-server.recommended',
    scope: 'project',
    page: 'mcp-server',
    kind: 'section',
    title: 'mcp.recommendedServers',
  },

  // ── Project › Pipelines ───────────────────────────────────────────────
  {
    id: 'pipelines.precommit',
    scope: 'project',
    page: 'pipelines',
    kind: 'section',
    title: 'Pre-commit Auto-fix',
    keywords: ['fixer model', 'max fix attempts', 'lint'],
  },
  {
    id: 'pipelines.review',
    scope: 'project',
    page: 'pipelines',
    kind: 'section',
    title: 'Post-commit Review',
    keywords: ['reviewer model', 'corrector model', 'max iterations'],
  },
  {
    id: 'pipelines.tests',
    scope: 'project',
    page: 'pipelines',
    kind: 'section',
    title: 'Test Auto-Fix',
    keywords: ['test command', 'fixer model', 'auto-fix failures', 'max fix attempts'],
  },

  // ── Project › Factory ─────────────────────────────────────────────────
  {
    id: 'factory.mode',
    scope: 'project',
    page: 'factory',
    kind: 'row',
    title: 'settings.projectFactoryMode',
    keywords: ['automatic', 'manual'],
  },
  {
    id: 'factory.label',
    scope: 'project',
    page: 'factory',
    kind: 'row',
    title: 'settings.projectFactoryLabel',
    description: 'settings.projectFactoryLabelDesc',
    keywords: ['issue', 'github'],
  },
  {
    id: 'factory.status',
    scope: 'project',
    page: 'factory',
    kind: 'row',
    title: 'settings.projectFactoryStatus',
    description: 'settings.projectFactoryStatusDesc',
    keywords: ['pause', 'paused', 'running'],
  },
  {
    id: 'factory.flow',
    scope: 'project',
    page: 'factory',
    kind: 'row',
    title: 'settings.projectFactoryFlow',
    description: 'settings.projectFactoryFlowDesc',
  },
  {
    id: 'factory.baseBranch',
    scope: 'project',
    page: 'factory',
    kind: 'row',
    title: 'settings.projectFactoryBaseBranch',
    description: 'settings.projectFactoryBaseBranchDesc',
    keywords: ['branch', 'base', 'target', 'merge', 'rama'],
  },
  {
    id: 'factory.concurrency',
    scope: 'project',
    page: 'factory',
    kind: 'row',
    title: 'settings.projectFactoryConcurrency',
    description: 'settings.projectFactoryConcurrencyDesc',
    keywords: ['max in flight', 'parallel'],
  },
  {
    id: 'factory.autoMerge',
    scope: 'project',
    page: 'factory',
    kind: 'row',
    title: 'settings.projectFactoryAutoMerge',
    description: 'settings.projectFactoryAutoMergeLowDesc',
    keywords: ['merge', 'risk', 'high risk', 'review'],
  },
  {
    id: 'factory.sensitivePaths',
    scope: 'project',
    page: 'factory',
    kind: 'row',
    title: 'settings.projectFactorySensitivePaths',
    description: 'settings.projectFactorySensitivePathsDesc',
    keywords: ['risk', 'glob', 'paths'],
  },
  {
    id: 'factory.sizeGateEnabled',
    scope: 'project',
    page: 'factory',
    kind: 'row',
    title: 'settings.projectFactorySizeGate',
    description: 'settings.projectFactorySizeGateDesc',
    keywords: ['risk', 'size', 'lines', 'high risk', 'gate', 'limit'],
  },
  {
    id: 'factory.maxLowRiskLines',
    scope: 'project',
    page: 'factory',
    kind: 'row',
    title: 'settings.projectFactoryMaxLowRiskLines',
    description: 'settings.projectFactoryMaxLowRiskLinesDesc',
    keywords: ['risk', 'size', 'lines', 'high risk', 'limit'],
  },
  {
    id: 'factory.approvalAdjustMaxLines',
    scope: 'project',
    page: 'factory',
    kind: 'row',
    title: 'settings.projectFactoryApprovalAdjust',
    description: 'settings.projectFactoryApprovalAdjustDesc',
    keywords: ['approval', 'approve', 'high risk', 'merge', 'adjustment', 'carry'],
  },
  {
    id: 'factory.holdPathsAwaitingApproval',
    scope: 'project',
    page: 'factory',
    kind: 'row',
    title: 'settings.projectFactoryHoldPaths',
    description: 'settings.projectFactoryHoldPathsDesc',
    keywords: ['approval', 'approve', 'high risk', 'paths', 'files', 'conflict', 'wait'],
  },
  {
    id: 'factory.sizeIgnoredPaths',
    scope: 'project',
    page: 'factory',
    kind: 'row',
    title: 'settings.projectFactorySizeIgnoredPaths',
    description: 'settings.projectFactorySizeIgnoredPathsDesc',
    keywords: ['risk', 'size', 'glob', 'paths', 'exclude', 'ignore'],
  },
  {
    id: 'factory.stageLimits',
    scope: 'project',
    page: 'factory',
    kind: 'row',
    title: 'settings.projectFactoryStageLimits',
    description: 'settings.projectFactoryStageLimitsDesc',
    keywords: ['limit', 'implement', 'review', 'concurrency'],
  },
  {
    id: 'factory.batch',
    scope: 'project',
    page: 'factory',
    kind: 'row',
    title: 'settings.projectFactoryBatch',
    description: 'settings.projectFactoryBatchDesc',
    keywords: ['merge queue', 'batch', 'bisect', 'wait'],
  },
  {
    id: 'factory.dependencies',
    scope: 'project',
    page: 'factory',
    kind: 'row',
    title: 'settings.projectFactoryDependencies',
    description: 'settings.projectFactoryDependenciesWaitDesc',
    keywords: ['blocker', 'stack', 'stacked', 'depends'],
  },
  {
    id: 'factory.tooBig',
    scope: 'project',
    page: 'factory',
    kind: 'row',
    title: 'settings.projectFactoryTooBig',
    description: 'settings.projectFactoryTooBigAskDesc',
    keywords: ['split', 'too big', 'large', 'triage', 'sub-issue', 'parts'],
  },
  {
    id: 'factory.specStage',
    scope: 'project',
    page: 'factory',
    kind: 'row',
    title: 'settings.projectFactorySpecStage',
    description: 'settings.projectFactorySpecStageDesc',
    keywords: ['spec', 'specification', 'product decisions', 'approve', 'triage', 'questions'],
  },
  {
    id: 'factory.commitSpecPath',
    scope: 'project',
    page: 'factory',
    kind: 'row',
    title: 'settings.projectFactoryCommitSpec',
    description: 'settings.projectFactoryCommitSpecDesc',
    keywords: ['spec', 'commit', 'docs', 'folder', 'path'],
  },
  {
    id: 'factory.stepOptions',
    scope: 'project',
    page: 'factory',
    kind: 'row',
    title: 'settings.projectFactoryStepOptions',
    description: 'settings.projectFactoryStepOptionsDesc',
    keywords: ['model', 'provider', 'effort', 'override', 'validate', 'flow', 'step'],
  },
  {
    id: 'factory.triggers',
    scope: 'project',
    page: 'factory',
    kind: 'row',
    title: 'settings.projectFactoryTriggers',
    description: 'settings.projectFactoryTriggersDesc',
    keywords: ['schedule', 'cron', 'trigger', 'nightly', 'run a flow', 'without an issue'],
  },
  {
    id: 'factory.laneLabelPrefix',
    scope: 'project',
    page: 'factory',
    kind: 'row',
    title: 'settings.projectFactoryLaneLabelPrefix',
    description: 'settings.projectFactoryLaneLabelPrefixDesc',
    keywords: ['lane', 'feature', 'label', 'prefix', 'parallel', 'branch'],
  },
  {
    id: 'factory.laneBranchPrefix',
    scope: 'project',
    page: 'factory',
    kind: 'row',
    title: 'settings.projectFactoryLaneBranchPrefix',
    description: 'settings.projectFactoryLaneBranchPrefixDesc',
    keywords: ['lane', 'feature', 'branch', 'prefix', 'parallel'],
  },
  {
    id: 'factory.lanes',
    scope: 'project',
    page: 'factory',
    kind: 'row',
    title: 'settings.projectFactoryLanes',
    description: 'settings.projectFactoryLanesDesc',
    keywords: ['lane', 'lanes', 'feature', 'parallel', 'sync', 'finish'],
  },
] as const satisfies readonly SettingsIndexEntry[];

export type SettingId = (typeof ENTRIES)[number]['id'];

/** An index entry whose id is a known `SettingId`. */
export type IndexedSetting = SettingsIndexEntry & { readonly id: SettingId };

export const SETTINGS_INDEX: readonly IndexedSetting[] = ENTRIES;

const BY_ID = new Map<string, SettingsIndexEntry>(ENTRIES.map((e) => [e.id, e]));

export function getSettingEntry(id: SettingId): SettingsIndexEntry {
  // Every SettingId is in the map by construction.
  return BY_ID.get(id)!;
}

/**
 * Search terms for whole pages, mostly pages whose content is user data
 * (runners, tokens, servers) and therefore has no indexed elements.
 */
export const SETTINGS_PAGE_KEYWORDS: Record<
  SettingsScope,
  Readonly<Record<string, readonly string[]>>
> = {
  preferences: {
    providers: ['claude', 'codex', 'gemini', 'cli', 'proveedores'],
    models: ['prompt picker', 'visibility', 'modelos'],
    github: ['token', 'pat'],
    'github-app': ['installation', 'manifest', 'app'],
    'api-tokens': ['personal access token', 'rest api', 'pat'],
    'ai-keys': ['api key', 'anthropic', 'openai'],
    'agent-profiles': ['execution profile', 'perfiles'],
    speech: ['voice', 'dictation', 'voz'],
    email: ['smtp', 'mail', 'correo', 'resend'],
    users: ['accounts', 'password', 'usuarios'],
    runners: ['runner', 'machine', 'máquina'],
    sandboxes: ['sandbox', 'boat', 'instabox'],
    'agent-templates': ['deep agent', 'template', 'plantillas'],
    extensions: ['plugins', 'extensiones'],
    system: ['gitoxide', 'native', 'build'],
  },
  project: {
    'agent-resources': ['resources', 'recursos'],
    'agent-profiles': ['execution profile', 'perfiles'],
    'mcp-server': ['mcp', 'servers', 'tools'],
    skills: ['skills', 'habilidades'],
    'startup-commands': ['startup', 'scripts', 'dev server', 'comandos'],
    'project-config': ['.funny.json', 'config', 'json'],
    hooks: ['git hooks', 'pre-commit', 'lefthook'],
    automations: ['cron', 'schedule', 'automatizaciones'],
    pipelines: ['review', 'lint', 'tests'],
    'archived-threads': ['archive', 'archivados'],
    factory: ['issue factory', 'fábrica'],
    security: ['secrets', 'env', 'environment variables', 'secretos'],
    collaborators: ['members', 'share', 'colaboradores'],
    runner: ['runner', 'dedicated', 'machine'],
  },
};
