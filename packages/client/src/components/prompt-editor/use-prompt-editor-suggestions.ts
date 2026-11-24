import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from 'react';

import {
  createFileSuggestion,
  createSlashSuggestion,
  createSymbolSuggestion,
  createWorkflowSuggestion,
  type SuggestionSourceRefs,
} from './suggestion-configs';
import {
  buildSlashSuggestionItems,
  buildWorkflowSuggestionItems,
  type PromptSlashResource,
  type PromptWorkflowResource,
  type SuggestionItem,
  type SuggestionMenuType,
} from './suggestion-items';
import { useSuggestionMenu, type SuggestionControls } from './use-suggestion-menu';

interface SuggestionSources {
  cwd?: string;
  slashSkills?: readonly PromptSlashResource[];
  slashSkillsLoading?: boolean;
  onSlashOpen?: () => void;
  sdkSlashCommands?: string[];
  workflows?: readonly PromptWorkflowResource[];
  workflowsLoading?: boolean;
  commandProvider?: string;
}

const NO_SLASH_SKILLS: readonly PromptSlashResource[] = [];
const NO_WORKFLOWS: readonly PromptWorkflowResource[] = [];

/**
 * Slash skills come from the owner (single source of truth) — mirror them,
 * and the other sources, into refs for synchronous reads inside the TipTap
 * suggestion callbacks.
 */
function useSuggestionSourceRefs(sources: SuggestionSources): SuggestionSourceRefs {
  const slashSkills = sources.slashSkills ?? NO_SLASH_SKILLS;
  const workflows = sources.workflows ?? NO_WORKFLOWS;
  const { cwd, onSlashOpen, sdkSlashCommands, workflowsLoading, commandProvider } = sources;

  const slashSkillsRef = useRef(slashSkills);
  const onSlashOpenRef = useRef(onSlashOpen);
  // Keep cwd ref current for async callbacks
  const cwdRef = useRef(cwd);
  const sdkSlashCommandsRef = useRef(sdkSlashCommands);
  const workflowsRef = useRef(workflows);
  const workflowsLoadingRef = useRef(workflowsLoading);
  const commandProviderRef = useRef(commandProvider);

  useLayoutEffect(() => {
    slashSkillsRef.current = slashSkills;
    onSlashOpenRef.current = onSlashOpen;
    cwdRef.current = cwd;
    sdkSlashCommandsRef.current = sdkSlashCommands;
    workflowsRef.current = workflows;
    workflowsLoadingRef.current = workflowsLoading;
    commandProviderRef.current = commandProvider;
  }, [
    commandProvider,
    cwd,
    onSlashOpen,
    sdkSlashCommands,
    slashSkills,
    workflows,
    workflowsLoading,
  ]);

  return useMemo(
    () => ({
      cwdRef,
      slashSkillsRef,
      onSlashOpenRef,
      sdkSlashCommandsRef,
      workflowsRef,
      workflowsLoadingRef,
      commandProviderRef,
    }),
    [],
  );
}

/**
 * Rebuild the open `/` menu whenever the owner's resolved skills, the SDK
 * commands, or the provider change — so a late eager-load, a lazy first
 * fetch, or a model/provider switch is reflected without re-opening the menu.
 * This replaces the editor's old internal skills cache.
 */
function useRefreshOpenSlashMenu(
  suggestionType: SuggestionMenuType | null,
  sources: SuggestionSources,
  controls: SuggestionControls,
  suggestionQueryRef: RefObject<string>,
) {
  const { slashSkills, slashSkillsLoading, sdkSlashCommands, commandProvider } = sources;
  const { applySuggestionItems, setSuggestionLoading } = controls;
  useEffect(() => {
    if (suggestionType !== 'slash') return;
    const skills = slashSkills ?? NO_SLASH_SKILLS;
    setSuggestionLoading(Boolean(slashSkillsLoading) && skills.length === 0);
    applySuggestionItems(
      buildSlashSuggestionItems({
        skills,
        sdkCommands: sdkSlashCommands ?? [],
        query: suggestionQueryRef.current,
        commandProvider,
      }),
    );
  }, [
    suggestionType,
    slashSkills,
    slashSkillsLoading,
    sdkSlashCommands,
    commandProvider,
    applySuggestionItems,
    suggestionQueryRef,
    setSuggestionLoading,
  ]);
}

/** Same for the open `>>` menu when the project's workflows change. */
function useRefreshOpenWorkflowMenu(
  suggestionType: SuggestionMenuType | null,
  sources: SuggestionSources,
  controls: SuggestionControls,
  suggestionQueryRef: RefObject<string>,
) {
  const { workflows, workflowsLoading } = sources;
  const { applySuggestionItems, setSuggestionLoading } = controls;
  useEffect(() => {
    if (suggestionType !== 'workflow') return;
    const list = workflows ?? NO_WORKFLOWS;
    setSuggestionLoading(Boolean(workflowsLoading) && list.length === 0);
    applySuggestionItems(
      buildWorkflowSuggestionItems({ workflows: list, query: suggestionQueryRef.current }),
    );
  }, [
    suggestionType,
    workflows,
    workflowsLoading,
    applySuggestionItems,
    suggestionQueryRef,
    setSuggestionLoading,
  ]);
}

/**
 * Everything behind the editor's suggestion menus: the shared menu state, the
 * owner's sources mirrored into refs, and one TipTap suggestion config per
 * trigger (@ files, / commands, >> workflows, # symbols).
 */
export function usePromptEditorSuggestions(sources: SuggestionSources) {
  const { state, controls, stateRefs, editorRef } = useSuggestionMenu();
  const { suggestionCommandRef } = controls;

  // Debounce timers for file and symbol fetching
  const fileTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const symbolTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const sourceRefs = useSuggestionSourceRefs(sources);

  useRefreshOpenSlashMenu(state.suggestionType, sources, controls, stateRefs.suggestionQueryRef);
  useRefreshOpenWorkflowMenu(state.suggestionType, sources, controls, stateRefs.suggestionQueryRef);

  // The configs read the sources through refs, so they only change with the
  // (stable) menu operations.
  const fileSuggestion = useCallback(
    () => createFileSuggestion(controls, sourceRefs, fileTimerRef),
    [controls, sourceRefs],
  );
  const slashSuggestion = useCallback(
    () => createSlashSuggestion(controls, sourceRefs),
    [controls, sourceRefs],
  );
  const workflowSuggestion = useCallback(
    () => createWorkflowSuggestion(controls, sourceRefs),
    [controls, sourceRefs],
  );
  const symbolSuggestion = useCallback(
    () => createSymbolSuggestion(controls, sourceRefs, symbolTimerRef),
    [controls, sourceRefs],
  );

  // ── Handle suggestion item selection from the popup ──
  const handleSuggestionSelect = useCallback(
    (item: SuggestionItem) => {
      suggestionCommandRef.current?.(item);
    },
    [suggestionCommandRef],
  );

  return {
    state,
    controls,
    suggestionTypeRef: stateRefs.suggestionTypeRef,
    editorRef,
    configs: { fileSuggestion, slashSuggestion, workflowSuggestion, symbolSuggestion },
    handleSuggestionSelect,
  };
}
