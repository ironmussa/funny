import { useLayoutEffect, useRef } from 'react';

import type { PromptEditorProps, PromptSlashResource, PromptWorkflowResource } from './types';

/**
 * Mirrors the props that TipTap's callbacks (captured at editor creation
 * time) read into refs, kept current in a layout effect.
 */
export function usePromptEditorRefs({
  cwd,
  slashSkills,
  slashSkillsLoading,
  onSlashOpen,
  sdkSlashCommands,
  workflows,
  workflowsLoading,
  commandProvider,
  onSubmit,
  onCycleMode,
  onHistoryNavigate,
  onChange,
  onFileMentionDrop,
}: PromptEditorProps) {
  // Slash skills come from the owner (single source of truth) — mirror them
  // into refs for synchronous reads inside the TipTap suggestion callbacks.
  const slashSkillsRef = useRef<readonly PromptSlashResource[]>(slashSkills ?? []);
  const slashSkillsLoadingRef = useRef(slashSkillsLoading);
  const onSlashOpenRef = useRef(onSlashOpen);
  // Keep cwd ref current for async callbacks
  const cwdRef = useRef(cwd);
  const sdkSlashCommandsRef = useRef(sdkSlashCommands);
  const workflowsRef = useRef<readonly PromptWorkflowResource[]>(workflows ?? []);
  const workflowsLoadingRef = useRef(workflowsLoading);
  const commandProviderRef = useRef(commandProvider);

  useLayoutEffect(() => {
    slashSkillsRef.current = slashSkills ?? [];
    slashSkillsLoadingRef.current = slashSkillsLoading;
    onSlashOpenRef.current = onSlashOpen;
    cwdRef.current = cwd;
    sdkSlashCommandsRef.current = sdkSlashCommands;
    workflowsRef.current = workflows ?? [];
    workflowsLoadingRef.current = workflowsLoading;
    commandProviderRef.current = commandProvider;
  }, [
    commandProvider,
    cwd,
    onSlashOpen,
    sdkSlashCommands,
    slashSkills,
    slashSkillsLoading,
    workflows,
    workflowsLoading,
  ]);

  // ── TipTap editor callbacks ──
  const onSubmitRef = useRef(onSubmit);
  const onCycleModeRef = useRef(onCycleMode);
  const onHistoryNavigateRef = useRef(onHistoryNavigate);
  const onChangeRef = useRef(onChange);
  const onFileMentionDropRef = useRef(onFileMentionDrop);

  useLayoutEffect(() => {
    onSubmitRef.current = onSubmit;
    onCycleModeRef.current = onCycleMode;
    onHistoryNavigateRef.current = onHistoryNavigate;
    onChangeRef.current = onChange;
    onFileMentionDropRef.current = onFileMentionDrop;
  }, [onChange, onCycleMode, onFileMentionDrop, onHistoryNavigate, onSubmit]);

  return {
    slashSkillsRef,
    slashSkillsLoadingRef,
    onSlashOpenRef,
    cwdRef,
    sdkSlashCommandsRef,
    workflowsRef,
    workflowsLoadingRef,
    commandProviderRef,
    onSubmitRef,
    onCycleModeRef,
    onHistoryNavigateRef,
    onChangeRef,
    onFileMentionDropRef,
  };
}

export type PromptEditorRefs = ReturnType<typeof usePromptEditorRefs>;
