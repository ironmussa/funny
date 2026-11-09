import type { AgentProvider, Project } from '@funny/shared';
import {
  DEFAULT_MODEL,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_PROVIDER,
  DEFAULT_THREAD_MODE,
  getModelContextWindow,
  type AgentModel,
} from '@funny/shared/models';
import { useMemo } from 'react';

import { useGitStatusForThread } from '@/data/git-status/hooks';
import { useProjects } from '@/data/projects/hooks';
import { normalizeEffort } from '@/lib/providers';
import { resolveThreadBranch } from '@/lib/utils';
import { useProjectStore } from '@/stores/project-store';
import { useThreadSelector } from '@/stores/thread-context';
import { useThreadStore } from '@/stores/thread-store';

import type { ThreadOverride } from './prompt-input-types';

// Stable empty default so threads without an init payload don't churn the editor.
const EMPTY_SLASH_COMMANDS: string[] = [];
const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Model defaults inherited from the project (falling back to global defaults). */
function resolveModelDefaults(project: Project | undefined) {
  const defaultProvider = project?.defaultProvider ?? DEFAULT_PROVIDER;
  const defaultModel = project?.defaultModel ?? DEFAULT_MODEL;
  return {
    defaultProvider,
    defaultModel,
    defaultEffort: normalizeEffort(defaultModel, defaultProvider, project?.defaultEffort),
  };
}

/** Mode defaults inherited from the project (falling back to global defaults). */
function resolveModeDefaults(project: Project | undefined) {
  return {
    defaultPermissionMode: project?.defaultPermissionMode ?? DEFAULT_PERMISSION_MODE,
    defaultThreadMode: project?.defaultMode ?? DEFAULT_THREAD_MODE,
  };
}

/**
 * Context-window usage percentage for the ring. Hidden until the agent has
 * actually reported usage: new and forked threads start at 0 and the displayed
 * % would be misleading (a fork inherits real context but no usage event has
 * fired yet for the new threadId). Codex SDK only reports aggregate usage for
 * a whole turn (which can span many model requests), not a snapshot of the
 * active context window, so never render it as a context percentage.
 */
function computeContextUsage(
  provider: AgentProvider | null | undefined,
  model: AgentModel | null | undefined,
  tokens: number,
) {
  const contextMaxTokens =
    provider && model ? getModelContextWindow(provider, model) : DEFAULT_CONTEXT_WINDOW;
  const contextPct =
    provider !== 'codex' && tokens > 0
      ? Math.min(100, (tokens / contextMaxTokens) * 100)
      : undefined;
  return { contextMaxTokens, contextPct };
}

/**
 * Resolves the project the composer works against. For an existing thread
 * this is the thread's OWN project — not the globally-selected one. This
 * matters in the live-columns grid, where each column renders its own
 * PromptInput for a different thread (and possibly a different project) while
 * the global selection points elsewhere. New threads resolve from the
 * selected/prop project.
 */
export function usePromptProjectContext({
  isNewThread,
  propProjectId,
  threadOverride,
}: {
  isNewThread: boolean;
  propProjectId?: string;
  threadOverride?: ThreadOverride;
}) {
  const projects = useProjects();
  const storeSelectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const storeThreadProjectId = useThreadSelector((t) => t?.projectId);
  const threadProjectId = threadOverride?.projectId ?? storeThreadProjectId;
  const resolvedProjectId =
    (!isNewThread && threadProjectId) || propProjectId || storeSelectedProjectId;
  const effectiveProject = resolvedProjectId
    ? projects.find((p) => p.id === resolvedProjectId)
    : undefined;
  // A new-thread composer can still be rendered beneath the previously active
  // thread's context. Never let that stale thread override the project chosen
  // for the new thread; existing-thread composers still follow their owner.
  const selectedProjectId = isNewThread
    ? resolvedProjectId
    : (threadProjectId ?? storeSelectedProjectId);
  const projectPath = useMemo(
    () => (resolvedProjectId ? (projects.find((p) => p.id === resolvedProjectId)?.path ?? '') : ''),
    [resolvedProjectId, projects],
  );

  return {
    projects,
    resolvedProjectId,
    selectedProjectId,
    effectiveProject,
    projectPath,
    ...resolveModelDefaults(effectiveProject),
    ...resolveModeDefaults(effectiveProject),
  };
}

/** User-message history (oldest → newest) for ↑/↓ prompt recall. */
function usePromptMessageHistory(threadId: string | null | undefined) {
  const threadMessages = useThreadStore((s) =>
    threadId ? s.threadDataById[threadId]?.messages : undefined,
  );
  const lastUserMessage = useThreadStore((s) =>
    threadId ? s.threadDataById[threadId]?.lastUserMessage : undefined,
  );
  // The loaded conversation window is normally enough here. `lastUserMessage`
  // is included separately for paginated threads, so add it when it falls
  // outside that window and keep history navigation useful for long threads.
  return useMemo(() => {
    const messages = threadMessages?.filter((message) => message.role === 'user') ?? [];
    if (lastUserMessage && !messages.some((message) => message.id === lastUserMessage.id)) {
      messages.push(lastUserMessage);
    }
    return messages.map((message) => message.content);
  }, [threadMessages, lastUserMessage]);
}

/** Active thread identity fields (resolved via context, overridable per column). */
function useActiveThreadIdentity(o: ThreadOverride) {
  const storePermissionMode = useThreadSelector((t) => t?.permissionMode);
  const storeWorktreePath = useThreadSelector((t) => t?.worktreePath);
  const storeProvider = useThreadSelector((t) => t?.provider);
  const storeModel = useThreadSelector((t) => t?.model);
  return {
    activeThreadPermissionMode: o.permissionMode ?? storePermissionMode,
    activeThreadWorktreePath: o.worktreePath ?? storeWorktreePath,
    activeThreadProvider: o.provider ?? storeProvider,
    activeThreadModel: o.model ?? storeModel,
  };
}

/** Active thread branch fields (resolved via context, overridable per column). */
function useActiveThreadBranches(o: ThreadOverride) {
  const storeBranch = useThreadSelector((t) => (t ? resolveThreadBranch(t) : undefined));
  const storeBaseBranch = useThreadSelector((t) => t?.baseBranch);
  return {
    activeThreadBranch: o.branch ?? storeBranch,
    activeThreadBaseBranch: o.baseBranch ?? storeBaseBranch,
  };
}

const EMPTY_OVERRIDE: ThreadOverride = {};

/** Everything the composer reads from the thread it is attached to. */
export function usePromptActiveThread(
  threadId: string | undefined,
  threadOverride: ThreadOverride | undefined,
) {
  const o = threadOverride ?? EMPTY_OVERRIDE;
  const identity = useActiveThreadIdentity(o);
  const branches = useActiveThreadBranches(o);
  // Full active thread + its working-tree status, for the prompt powerline bar.
  const activeThread = useThreadSelector((t) => t);
  // SDK-reported slash commands for this thread — merged into the editor's
  // slash autocomplete alongside skills.
  const sdkSlashCommands =
    useThreadSelector((t) => t?.initInfo?.slashCommands) ?? EMPTY_SLASH_COMMANDS;
  const activeThreadGitStatus = useGitStatusForThread(threadId);
  const storeContextTokens = useThreadSelector((t) => t?.contextUsage?.cumulativeInputTokens ?? 0);
  const activeThreadContextTokens = o.contextUsage?.cumulativeInputTokens ?? storeContextTokens;
  const activeThreadContextBreakdown = useThreadSelector((t) => t?.contextUsage?.breakdown);
  const activeThreadLastEffort = useThreadSelector((t) => t?.lastUserMessage?.effort);
  const activeThreadRuntime = useThreadSelector((t) => t?.runtime);
  const updateThreadPermissionMode = useThreadStore((s) => s.updateThreadPermissionMode);
  const messageHistory = usePromptMessageHistory(threadId);

  return {
    ...identity,
    ...branches,
    activeThread,
    sdkSlashCommands,
    activeThreadGitStatus,
    activeThreadContextTokens,
    activeThreadContextBreakdown,
    activeThreadLastEffort,
    activeThreadRuntime,
    updateThreadPermissionMode,
    messageHistory,
    ...computeContextUsage(
      identity.activeThreadProvider,
      identity.activeThreadModel,
      activeThreadContextTokens,
    ),
  };
}
