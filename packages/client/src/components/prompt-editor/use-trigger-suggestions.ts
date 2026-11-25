import { useCallback, useEffect, useRef } from 'react';

import { api } from '@/lib/api';
import { metric } from '@/lib/telemetry';

import { insertInlineNodeWithTrailingSpace, isString } from './extensions';
import {
  buildSlashSuggestionItems,
  buildWorkflowSuggestionItems,
  normalizeWorkflowQuery,
  WORKFLOW_SUGGESTION_MATCH_OPTIONS,
} from './suggestion-items';
import type {
  PromptEditorProps,
  PromptSlashResource,
  PromptWorkflowResource,
  SuggestionItem,
  SuggestionMenuType,
} from './types';
import type { PromptEditorRefs } from './use-prompt-editor-refs';
import type { SuggestionMenuActions } from './use-suggestion-menu';

type RefOf<T> = React.RefObject<T>;

/**
 * The TipTap suggestion `render` lifecycle shared by the @, / and # menus:
 * open the shared menu on start, follow TipTap's updates, claim keys only
 * while this menu is the one on screen.
 */
function makeMenuRender(
  actions: SuggestionMenuActions,
  menuType: Exclude<SuggestionMenuType, 'workflow'>,
  onExit: () => void,
) {
  return () => ({
    onStart: (props: any) => {
      actions.triggerPosRef.current = props.range?.from ?? null;
      actions.setSuggestionType(menuType);
      actions.setSuggestionItems(props.items);
      actions.setSuggestionIndex(0);
      actions.setSuggestionQuery(props.query ?? '');
      actions.setSuggestionRect(() => props.clientRect);
      actions.suggestionCommandRef.current = props.command;
    },
    onUpdate: (props: any) => {
      // Only reset the selected index when items actually change
      actions.applySuggestionItems(props.items);
      actions.setSuggestionQuery(actions.getFullQuery(props.query ?? ''));
      actions.setSuggestionRect(() => props.clientRect);
      actions.suggestionCommandRef.current = props.command;
    },
    onKeyDown: actions.makeSuggestionKeyDown(menuType),
    onExit,
  });
}

// ── File suggestion config (@ trigger) ──
export function useFileSuggestion(
  actions: SuggestionMenuActions,
  cwdRef: RefOf<string | undefined>,
) {
  // Debounce timer for file fetching
  const fileTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  return useCallback(
    () => ({
      char: '@',
      allowSpaces: false,
      allowedPrefixes: [' ', '\n'],
      items: ({ query }: { query: string }) => {
        // Use the full text after @ (up to next space) instead of TipTap's
        // caret-dependent query, so moving the caret doesn't change results
        const fullQuery = actions.getFullQuery(query);
        // Defer state updates out of TipTap's render cycle to avoid
        // "Cannot update a component while rendering a different component"
        queueMicrotask(() => {
          actions.setSuggestionQuery(fullQuery);
          actions.setSuggestionLoading(true);
        });
        // Return a promise that resolves with items after debounce
        return new Promise<SuggestionItem[]>((resolve) => {
          if (fileTimerRef.current) clearTimeout(fileTimerRef.current);
          fileTimerRef.current = setTimeout(async () => {
            const path = cwdRef.current;
            if (!path) {
              actions.setSuggestionLoading(false);
              resolve([]);
              return;
            }
            const result = await api.browseFiles(path, fullQuery || undefined);
            let items: SuggestionItem[] = [];
            if (result.isOk()) {
              items = result.value.files.map((f) => {
                const file = isString(f) ? { path: f, type: 'file' as const } : f;
                return {
                  id: file.path,
                  label: file.path,
                  path: file.path,
                  fileType: file.type,
                  type: 'file' as const,
                };
              });
              actions.setSuggestionTruncated(result.value.truncated);
            }
            actions.setSuggestionLoading(false);
            resolve(items);
          }, 150);
        });
      },
      command: ({ editor, range, props }: any) => {
        insertInlineNodeWithTrailingSpace(editor, range, 'fileMention', {
          id: props.path ?? props.id,
          label: props.label.split('/').pop() ?? props.label,
          path: props.path ?? props.id,
          fileType: props.fileType ?? 'file',
        });
      },
      render: makeMenuRender(actions, 'file', actions.closeSuggestions),
    }),
    // Intentionally minimal: cwd/loadSkills accessed via refs
    [actions, cwdRef],
  );
}

// ── Slash command suggestion config (/ trigger) ──
export function useSlashSuggestion(
  actions: SuggestionMenuActions,
  suggestionType: SuggestionMenuType | null,
  props: Pick<
    PromptEditorProps,
    'slashSkills' | 'slashSkillsLoading' | 'sdkSlashCommands' | 'commandProvider'
  >,
  refs: Pick<PromptEditorRefs, 'onSlashOpenRef' | 'slashSkillsRef' | 'sdkSlashCommandsRef'> & {
    commandProviderRef: RefOf<string | undefined>;
  },
) {
  const { slashSkills, slashSkillsLoading, sdkSlashCommands, commandProvider } = props;
  const { onSlashOpenRef, slashSkillsRef, sdkSlashCommandsRef, commandProviderRef } = refs;

  // Rebuild the open `/` menu whenever the owner's resolved skills, the SDK
  // commands, or the provider change — so a late eager-load, a lazy first
  // fetch, or a model/provider switch is reflected without re-opening the menu.
  // This replaces the editor's old internal skills cache.
  useEffect(() => {
    if (suggestionType !== 'slash') return;
    actions.setSuggestionLoading(Boolean(slashSkillsLoading) && (slashSkills?.length ?? 0) === 0);
    actions.applySuggestionItems(
      buildSlashSuggestionItems({
        skills: slashSkills ?? [],
        sdkCommands: sdkSlashCommands ?? [],
        query: actions.suggestionQueryRef.current,
        commandProvider,
      }),
    );
  }, [suggestionType, slashSkills, slashSkillsLoading, sdkSlashCommands, commandProvider, actions]);

  return useCallback(
    () => ({
      char: '/',
      allowSpaces: false,
      allowedPrefixes: [' ', '\n'],
      items: ({ query }: { query: string }) => {
        const fullQuery = actions.getFullQuery(query);
        // Defer state updates out of TipTap's render cycle
        queueMicrotask(() => actions.setSuggestionQuery(fullQuery));
        // Lazy owners begin their fetch here; eager owners no-op. The reactive
        // effect above rebuilds the menu once the resolved skills arrive.
        onSlashOpenRef.current?.();
        const t0 = performance.now();
        const skills: readonly PromptSlashResource[] = slashSkillsRef.current;
        const sdkCommands = sdkSlashCommandsRef.current ?? [];
        const matched = buildSlashSuggestionItems({
          skills,
          sdkCommands,
          query: fullQuery,
          commandProvider: commandProviderRef.current,
        });
        metric('palette.slash.filter_ms', performance.now() - t0, {
          type: 'gauge',
          attributes: {
            query_len: String(fullQuery.length),
            total: String(skills.length + sdkCommands.length),
            matched: String(matched.length),
          },
        });
        return matched;
      },
      command: ({ editor, range, props: itemProps }: any) => {
        insertInlineNodeWithTrailingSpace(editor, range, 'slashCommand', {
          id: itemProps.id,
          label: itemProps.label,
        });
      },
      render: makeMenuRender(actions, 'slash', () => {
        actions.triggerPosRef.current = null;
        actions.setSuggestionType(null);
        actions.setSuggestionItems([]);
        actions.setSuggestionQuery('');
        actions.setSuggestionLoading(false);
      }),
    }),
    [actions, onSlashOpenRef, slashSkillsRef, sdkSlashCommandsRef, commandProviderRef],
  );
}

// ── Workflow suggestion config (>> trigger) ──
export function useWorkflowSuggestion(
  actions: SuggestionMenuActions,
  suggestionType: SuggestionMenuType | null,
  props: Pick<PromptEditorProps, 'workflows' | 'workflowsLoading'>,
  refs: Pick<PromptEditorRefs, 'workflowsRef' | 'workflowsLoadingRef'>,
) {
  const { workflows, workflowsLoading } = props;
  const { workflowsRef, workflowsLoadingRef } = refs;

  useEffect(() => {
    if (suggestionType !== 'workflow') return;
    actions.setSuggestionLoading(Boolean(workflowsLoading) && (workflows?.length ?? 0) === 0);
    actions.applySuggestionItems(
      buildWorkflowSuggestionItems({
        workflows: workflows ?? [],
        query: actions.suggestionQueryRef.current,
      }),
    );
  }, [suggestionType, workflows, workflowsLoading, actions]);

  return useCallback(() => {
    /** Clears the menu when the query stops being a `>>` invocation. */
    const dismissIfNotWorkflow = (fullQuery: string): boolean => {
      if (fullQuery.startsWith('>')) return false;
      actions.setSuggestionType(null);
      actions.setSuggestionItems([]);
      actions.setSuggestionQuery('');
      return true;
    };
    return {
      ...WORKFLOW_SUGGESTION_MATCH_OPTIONS,
      items: ({ query }: { query: string }) => {
        const fullQuery = actions.getFullQuery(query);
        if (!fullQuery.startsWith('>')) return [];

        const workflowQuery = normalizeWorkflowQuery(fullQuery);
        const available: readonly PromptWorkflowResource[] = workflowsRef.current;
        queueMicrotask(() => {
          actions.setSuggestionQuery(workflowQuery);
          actions.setSuggestionLoading(
            Boolean(workflowsLoadingRef.current) && workflowsRef.current.length === 0,
          );
        });

        const t0 = performance.now();
        const matched = buildWorkflowSuggestionItems({
          workflows: available,
          query: workflowQuery,
        });
        metric('palette.workflow.filter_ms', performance.now() - t0, {
          type: 'gauge',
          attributes: {
            query_len: String(workflowQuery.length),
            total: String(workflowsRef.current.length),
            matched: String(matched.length),
          },
        });
        return matched;
      },
      command: ({ editor, range, props: itemProps }: any) => {
        const docSize = editor.state.doc.content.size;
        const safeRange = {
          from: Math.min(range.from, docSize),
          to: Math.min(range.to, docSize),
        };
        editor
          .chain()
          .focus()
          .insertContentAt(safeRange, { type: 'text', text: `>> ${itemProps.label} ` })
          .run();
      },
      render: () => ({
        onStart: (startProps: any) => {
          actions.triggerPosRef.current = startProps.range?.from ?? null;
          const fullQuery = actions.getFullQuery(startProps.query ?? '');
          if (dismissIfNotWorkflow(fullQuery)) return;
          actions.setSuggestionType('workflow');
          actions.setSuggestionItems(startProps.items);
          actions.setSuggestionIndex(0);
          actions.setSuggestionQuery(normalizeWorkflowQuery(fullQuery));
          actions.setSuggestionRect(() => startProps.clientRect);
          actions.suggestionCommandRef.current = startProps.command;
        },
        onUpdate: (updateProps: any) => {
          const fullQuery = actions.getFullQuery(updateProps.query ?? '');
          if (dismissIfNotWorkflow(fullQuery)) return;
          actions.setSuggestionType('workflow');
          actions.applySuggestionItems(updateProps.items);
          actions.setSuggestionQuery(normalizeWorkflowQuery(fullQuery));
          actions.setSuggestionRect(() => updateProps.clientRect);
          actions.suggestionCommandRef.current = updateProps.command;
        },
        onKeyDown: actions.makeSuggestionKeyDown('workflow'),
        onExit: () => {
          actions.triggerPosRef.current = null;
          actions.setSuggestionType(null);
          actions.setSuggestionItems([]);
          actions.setSuggestionQuery('');
          actions.setSuggestionLoading(false);
        },
      }),
    };
  }, [actions, workflowsRef, workflowsLoadingRef]);
}

// ── Symbol suggestion config (# trigger) ──
export function useSymbolSuggestion(
  actions: SuggestionMenuActions,
  cwdRef: RefOf<string | undefined>,
) {
  const symbolTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  return useCallback(
    () => ({
      char: '#',
      allowSpaces: false,
      allowedPrefixes: [' ', '\n'],
      items: ({ query }: { query: string }) => {
        const fullQuery = actions.getFullQuery(query);
        // Defer state updates out of TipTap's render cycle
        queueMicrotask(() => {
          actions.setSuggestionQuery(fullQuery);
          actions.setSuggestionLoading(true);
        });
        return new Promise<SuggestionItem[]>((resolve) => {
          if (symbolTimerRef.current) clearTimeout(symbolTimerRef.current);
          symbolTimerRef.current = setTimeout(async () => {
            const path = cwdRef.current;
            if (!path) {
              actions.setSuggestionLoading(false);
              resolve([]);
              return;
            }
            // Support #file:symbol syntax
            const [fileScope, symbolQuery] = fullQuery.includes(':')
              ? [fullQuery.split(':')[0], fullQuery.split(':').slice(1).join(':')]
              : [undefined, fullQuery];

            const result = await api.searchSymbols(path, symbolQuery || undefined, fileScope);
            let items: SuggestionItem[] = [];
            if (result.isOk()) {
              items = result.value.symbols.map((s) => ({
                id: `${s.filePath}:${s.name}:${s.line}`,
                label: s.containerName ? `${s.containerName}.${s.name}` : s.name,
                path: s.filePath,
                symbolKind: s.kind,
                symbolLine: s.line,
                symbolEndLine: s.endLine,
                type: 'symbol' as const,
              }));
              actions.setSuggestionTruncated(result.value.truncated);

              // If not indexed yet, trigger indexing
              if (!result.value.indexed) {
                api.triggerSymbolIndex(path);
              }
            }
            actions.setSuggestionLoading(false);
            resolve(items);
          }, 150);
        });
      },
      command: ({ editor, range, props }: any) => {
        insertInlineNodeWithTrailingSpace(editor, range, 'symbolMention', {
          id: props.id,
          label: props.label,
          path: props.path ?? '',
          kind: props.symbolKind ?? 'function',
          line: props.symbolLine ?? 0,
          endLine: props.symbolEndLine,
        });
      },
      render: makeMenuRender(actions, 'symbol', actions.closeSuggestions),
    }),
    [actions, cwdRef],
  );
}
