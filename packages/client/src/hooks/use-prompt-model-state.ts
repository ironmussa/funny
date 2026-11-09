import type { PermissionMode } from '@funny/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { useProjectSandbox } from '@/data/runner/hooks';
import { applySandboxModelGroups } from '@/hooks/use-runner-provider-groups';
import { useUnifiedPromptModelGroups } from '@/hooks/use-unified-prompt-model-groups';
import {
  filterVisibleModelGroups,
  getEffortLevels,
  normalizeEffort,
  parseUnifiedModel,
} from '@/lib/providers';
import { buildRuntimeModes, isSandboxRuntimeChoice } from '@/lib/thread-payload';
import { runsInSandbox } from '@/lib/thread-variant';
import { useSettingsStore } from '@/stores/settings-store';
import { useUIStore } from '@/stores/ui-store';

type ModelGroups = { disabled?: boolean; models: { value: string }[] }[];

/** First usable model when the current selection can't run on the target, else undefined. */
function findSandboxFallbackModel(groups: ModelGroups, unifiedModel: string) {
  const usable = groups.find((g) => !g.disabled)?.models[0];
  const selectedUsable = groups.some(
    (g) => !g.disabled && g.models.some((m) => m.value === unifiedModel),
  );
  return usable && !selectedUsable ? usable.value : undefined;
}

/** The composer's sandbox on/off toggle for the project, or null when it has none. */
export interface SandboxToggle {
  label: string;
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
}

/**
 * The project's sandbox toggle (change project-sandboxes): shown for a new,
 * non-scratch thread when the user configured a sandbox for the project. It
 * starts at the configured default; a choice only holds for that project.
 */
export function useSandboxToggle(projectId: string | null | undefined, offered: boolean) {
  const { sandbox } = useProjectSandbox(offered ? projectId : null);
  const [choice, setChoice] = useState<{ projectId: string; enabled: boolean } | null>(null);
  return useMemo((): SandboxToggle | null => {
    if (!sandbox) return null;
    const { projectId: id, enabledByDefault } = sandbox.settings;
    return {
      label: sandbox.connection?.label ?? 'Sandbox',
      enabled: choice?.projectId === id ? choice.enabled : enabledByDefault,
      setEnabled: (enabled) => setChoice({ projectId: id, enabled }),
    };
  }, [sandbox, choice]);
}

/** Runtime (local / launcher / project sandbox) + worktree toggle for the composer. */
function usePromptRuntime({
  isNewThread,
  projectId,
  launcherUrl,
  defaultThreadMode,
  onWorktreeModeChange,
}: {
  isNewThread: boolean;
  projectId: string | null | undefined;
  launcherUrl: string | null | undefined;
  defaultThreadMode: string;
  onWorktreeModeChange?: (enabled: boolean) => void;
}) {
  const [createWorktree, setCreateWorktreeRaw] = useState(defaultThreadMode === 'worktree');
  const setCreateWorktree = useCallback(
    (v: boolean) => {
      setCreateWorktreeRaw(v);
      onWorktreeModeChange?.(v);
    },
    [onWorktreeModeChange],
  );
  const [selectedRuntime, setRuntime] = useState<string>('local');
  const hasLauncher = !!launcherUrl;
  // Scratch threads have no repository to clone: never a sandbox.
  const isScratch = useUIStore((s) => s.newThreadIsScratch);
  const sandboxToggle = useSandboxToggle(projectId, isNewThread && !isScratch);
  const runtimeModes = useMemo(() => buildRuntimeModes({ hasLauncher }), [hasLauncher]);
  // A sandbox that is on replaces the local / remote choice.
  const runtime = sandboxToggle?.enabled ? 'sandbox' : selectedRuntime;
  return {
    createWorktree,
    setCreateWorktree,
    runtime,
    setRuntime,
    runtimeModes,
    hasLauncher,
    sandboxToggle,
  };
}

/** Visible model groups, restricted to sandbox-capable providers when targeting a sandbox. */
function useVisibleModelGroups(unifiedModel: string, targetsSandbox: boolean) {
  const baseUnifiedModelGroups = useUnifiedPromptModelGroups();
  const hiddenPromptModels = useSettingsStore((s) => s.hiddenPromptModels);
  return useMemo(() => {
    const visible = filterVisibleModelGroups(
      baseUnifiedModelGroups,
      hiddenPromptModels,
      unifiedModel,
    );
    return targetsSandbox ? applySandboxModelGroups(visible) : visible;
  }, [baseUnifiedModelGroups, hiddenPromptModels, unifiedModel, targetsSandbox]);
}

/** Calls `onProviderChange` once per distinct provider, whatever the source of the change. */
function useProviderChangeNotifier(
  currentProvider: string,
  onProviderChange: ((provider: string) => void) | undefined,
) {
  const lastNotifiedProviderRef = useRef<string | undefined>(undefined);
  const notifyProviderChange = useCallback(
    (nextProvider: string) => {
      if (lastNotifiedProviderRef.current === nextProvider) return;
      lastNotifiedProviderRef.current = nextProvider;
      onProviderChange?.(nextProvider);
    },
    [onProviderChange],
  );
  // Intentional live-draft synchronization: provider can change from the model
  // picker or from active-thread/default hydration effects. The ref keeps the
  // parent callback idempotent across both sources.
  useEffect(() => {
    notifyProviderChange(currentProvider);
  }, [currentProvider, notifyProviderChange]);
  return notifyProviderChange;
}

interface ModelSelectionArgs {
  isNewThread: boolean;
  runtime: string;
  defaultProvider: string;
  defaultModel: string;
  defaultEffort: string;
  activeThreadProvider: string | null | undefined;
  activeThreadModel: string | null | undefined;
  activeThreadLastEffort: string | null | undefined;
  activeThreadRuntime: string | undefined;
  onProviderChange?: (provider: string) => void;
}

/** Keeps model + effort in sync with the active thread (or project defaults for a new one). */
function useSyncModelWithThread(
  args: ModelSelectionArgs,
  current: { provider: string; model: string },
  setUnifiedModelRaw: (v: string) => void,
  setEffort: (updater: (prev: string) => string) => void,
) {
  const {
    isNewThread,
    activeThreadProvider,
    activeThreadModel,
    activeThreadLastEffort,
    defaultProvider,
    defaultModel,
    defaultEffort,
  } = args;

  useEffect(() => {
    if (!isNewThread && activeThreadProvider && activeThreadModel) {
      setUnifiedModelRaw(`${activeThreadProvider}:${activeThreadModel}`);
    } else if (isNewThread) {
      setUnifiedModelRaw(`${defaultProvider}:${defaultModel}`);
    }
  }, [
    isNewThread,
    activeThreadProvider,
    activeThreadModel,
    defaultProvider,
    defaultModel,
    setUnifiedModelRaw,
  ]);

  useEffect(() => {
    if (isNewThread) {
      setEffort(() => defaultEffort);
      return;
    }
    setEffort((currentEffort) =>
      normalizeEffort(
        activeThreadModel ?? current.model,
        activeThreadProvider ?? current.provider,
        activeThreadLastEffort ?? currentEffort,
      ),
    );
  }, [
    isNewThread,
    defaultEffort,
    activeThreadLastEffort,
    activeThreadModel,
    activeThreadProvider,
    current.model,
    current.provider,
    setEffort,
  ]);
}

/** Unified `provider:model` selection, thinking effort, and the visible model groups. */
function usePromptModelSelection(args: ModelSelectionArgs) {
  const { isNewThread, runtime, defaultProvider, defaultModel, defaultEffort } = args;
  const [unifiedModel, setUnifiedModelRaw] = useState<string>(`${defaultProvider}:${defaultModel}`);
  const [effort, setEffort] = useState<string>(defaultEffort);

  // A sandbox thread (new, or a follow-up on one) doesn't depend on the user's runners.
  const targetsSandbox = isNewThread
    ? isSandboxRuntimeChoice(runtime)
    : runsInSandbox({ runtime: args.activeThreadRuntime });
  const unifiedModelGroups = useVisibleModelGroups(unifiedModel, targetsSandbox);

  const { provider: currentProvider, model: currentModel } = useMemo(
    () => parseUnifiedModel(unifiedModel),
    [unifiedModel],
  );
  const notifyProviderChange = useProviderChangeNotifier(currentProvider, args.onProviderChange);
  const setUnifiedModel = useCallback(
    (nextUnifiedModel: string) => {
      const { provider: nextProvider, model: nextModel } = parseUnifiedModel(nextUnifiedModel);
      if (nextProvider !== currentProvider) {
        notifyProviderChange(nextProvider);
      }
      setEffort((currentEffort) => normalizeEffort(nextModel, nextProvider, currentEffort));
      setUnifiedModelRaw(nextUnifiedModel);
    },
    [currentProvider, notifyProviderChange],
  );
  // Choosing a sandbox moves a selection it can't run to its first usable model.
  useEffect(() => {
    if (!targetsSandbox) return;
    const fallback = findSandboxFallbackModel(unifiedModelGroups, unifiedModel);
    if (fallback) setUnifiedModel(fallback);
  }, [targetsSandbox, unifiedModelGroups, unifiedModel, setUnifiedModel]);
  const effortOptions = useMemo(
    () => getEffortLevels(currentModel, currentProvider),
    [currentProvider, currentModel],
  );

  useSyncModelWithThread(
    args,
    { provider: currentProvider, model: currentModel },
    setUnifiedModelRaw,
    setEffort,
  );

  return {
    unifiedModel,
    setUnifiedModel,
    unifiedModelGroups,
    currentProvider,
    currentModel,
    effort,
    setEffort,
    effortOptions,
  };
}

/** Permission-mode options for the provider (`auto` is Claude-only). */
function usePermissionModeOptions(currentProvider: string) {
  const { t } = useTranslation();
  return useMemo(() => {
    const baseModes = [
      { value: 'ask', label: t('prompt.ask') },
      { value: 'plan', label: t('prompt.plan') },
      { value: 'autoEdit', label: t('prompt.autoEdit') },
      { value: 'confirmEdit', label: t('prompt.askBeforeEdits') },
    ];
    if (currentProvider === 'claude') {
      baseModes.splice(2, 0, { value: 'auto', label: t('prompt.auto') });
    }
    return baseModes;
  }, [t, currentProvider]);
}

/**
 * Permission mode for the composer. On an existing thread, picking a mode
 * persists it to the thread (rolling back the picker on failure).
 */
function usePromptPermissionMode({
  isNewThread,
  effectiveThreadId,
  currentProvider,
  defaultPermissionMode,
  activeThreadPermissionMode,
  updateThreadPermissionMode,
}: {
  isNewThread: boolean;
  effectiveThreadId: string | undefined;
  currentProvider: string;
  defaultPermissionMode: string;
  activeThreadPermissionMode: string | null | undefined;
  updateThreadPermissionMode: (threadId: string, mode: PermissionMode) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<string>(defaultPermissionMode);
  const modeMutationRef = useRef(0);
  const modes = usePermissionModeOptions(currentProvider);

  const applyPersistedMode = useCallback(
    (nextMode: string) => {
      setMode(() => nextMode);
      if (isNewThread || !effectiveThreadId || nextMode === activeThreadPermissionMode) return;

      const mutation = ++modeMutationRef.current;
      void updateThreadPermissionMode(effectiveThreadId, nextMode as PermissionMode).then(
        (saved) => {
          // Preserve a newer picker action. The store rolled back the failed
          // update already; this only repairs the hook-local selected value.
          if (!saved && mutation === modeMutationRef.current) {
            setMode(activeThreadPermissionMode ?? defaultPermissionMode);
            toast.error(t('thread.permissionModeSaveFailed', 'Could not save permission mode'));
          }
        },
      );
    },
    [
      activeThreadPermissionMode,
      defaultPermissionMode,
      effectiveThreadId,
      isNewThread,
      t,
      updateThreadPermissionMode,
    ],
  );

  // Auto mode is Claude-only — fall back to autoEdit when switching providers.
  // Existing threads persist that provider-imposed fallback as well.
  useEffect(() => {
    if (mode === 'auto' && currentProvider !== 'claude') {
      applyPersistedMode('autoEdit');
    }
  }, [applyPersistedMode, currentProvider, mode]);

  // Sync mode with the active thread (or project default for a new thread).
  useEffect(() => {
    if (!isNewThread && activeThreadPermissionMode) {
      setMode(activeThreadPermissionMode);
    } else if (isNewThread) {
      setMode(defaultPermissionMode);
    }
  }, [isNewThread, activeThreadPermissionMode, defaultPermissionMode]);

  return { mode, setMode: applyPersistedMode, modes };
}

/** Runtime + model/effort + permission-mode selection for the composer. */
export function usePromptSelection({
  isNewThread,
  effectiveThreadId,
  project,
  active,
  onWorktreeModeChange,
  onProviderChange,
}: {
  isNewThread: boolean;
  effectiveThreadId: string | undefined;
  project: {
    effectiveProject?: { launcherUrl?: string | null };
    resolvedProjectId?: string | null;
    defaultProvider: string;
    defaultModel: string;
    defaultEffort: string;
    defaultPermissionMode: string;
    defaultThreadMode: string;
  };
  active: {
    activeThreadProvider: string | null | undefined;
    activeThreadModel: string | null | undefined;
    activeThreadLastEffort: string | null | undefined;
    activeThreadRuntime: string | undefined;
    activeThreadPermissionMode: string | null | undefined;
    updateThreadPermissionMode: (threadId: string, mode: PermissionMode) => Promise<boolean>;
  };
  onWorktreeModeChange?: (enabled: boolean) => void;
  onProviderChange?: (provider: string) => void;
}) {
  const runtimeState = usePromptRuntime({
    isNewThread,
    projectId: project.resolvedProjectId,
    launcherUrl: project.effectiveProject?.launcherUrl,
    defaultThreadMode: project.defaultThreadMode,
    onWorktreeModeChange,
  });
  const model = usePromptModelSelection({
    isNewThread,
    runtime: runtimeState.runtime,
    defaultProvider: project.defaultProvider,
    defaultModel: project.defaultModel,
    defaultEffort: project.defaultEffort,
    activeThreadProvider: active.activeThreadProvider,
    activeThreadModel: active.activeThreadModel,
    activeThreadLastEffort: active.activeThreadLastEffort,
    activeThreadRuntime: active.activeThreadRuntime,
    onProviderChange,
  });
  const permission = usePromptPermissionMode({
    isNewThread,
    effectiveThreadId,
    currentProvider: model.currentProvider,
    defaultPermissionMode: project.defaultPermissionMode,
    activeThreadPermissionMode: active.activeThreadPermissionMode,
    updateThreadPermissionMode: active.updateThreadPermissionMode,
  });
  return { runtimeState, model, permission };
}
