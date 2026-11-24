import type { RefObject } from 'react';

import { api } from '@/lib/api';
import { metric } from '@/lib/telemetry';

import { insertInlineNodeWithTrailingSpace } from './extensions';
import {
  buildSlashSuggestionItems,
  buildWorkflowSuggestionItems,
  normalizeWorkflowQuery,
  WORKFLOW_SUGGESTION_MATCH_OPTIONS,
  type PromptSlashResource,
  type PromptWorkflowResource,
  type SuggestionItem,
  type SuggestionMenuType,
} from './suggestion-items';
import type { SuggestionControls } from './use-suggestion-menu';

/** Owner-supplied sources, mirrored into refs for the TipTap callbacks. */
export interface SuggestionSourceRefs {
  cwdRef: RefObject<string | undefined>;
  slashSkillsRef: RefObject<readonly PromptSlashResource[]>;
  onSlashOpenRef: RefObject<(() => void) | undefined>;
  sdkSlashCommandsRef: RefObject<string[] | undefined>;
  workflowsRef: RefObject<readonly PromptWorkflowResource[]>;
  workflowsLoadingRef: RefObject<boolean | undefined>;
  commandProviderRef: RefObject<string | undefined>;
}

type DebounceTimerRef = RefObject<ReturnType<typeof setTimeout> | undefined>;

/** Match options of a single-character trigger typed after a space or newline. */
function triggerOn(char: string) {
  return { char, allowSpaces: false, allowedPrefixes: [' ', '\n'] };
}

function startMenu(c: SuggestionControls, type: SuggestionMenuType, props: any) {
  c.triggerPosRef.current = props.range?.from ?? null;
  c.setSuggestionType(type);
  c.setSuggestionItems(props.items);
  c.setSuggestionIndex(0);
  c.setSuggestionQuery(props.query ?? '');
  c.setSuggestionRect(() => props.clientRect);
  c.suggestionCommandRef.current = props.command;
}

function updateMenu(c: SuggestionControls, props: any) {
  // Only reset the selected index when items actually change
  c.applySuggestionItems(props.items as SuggestionItem[]);
  c.setSuggestionQuery(c.getFullQuery(props.query ?? ''));
  c.setSuggestionRect(() => props.clientRect);
  c.suggestionCommandRef.current = props.command;
}

/** Like `closeSuggestions`, but leaves the truncated flag as it is. */
function exitMenu(c: SuggestionControls) {
  c.triggerPosRef.current = null;
  c.setSuggestionType(null);
  c.setSuggestionItems([]);
  c.setSuggestionQuery('');
  c.setSuggestionLoading(false);
}

function hideMenu(c: SuggestionControls) {
  c.setSuggestionType(null);
  c.setSuggestionItems([]);
  c.setSuggestionQuery('');
}

/**
 * Debounced lookup of a cwd-scoped menu (files, symbols): shows the loading
 * state at once, then resolves with `load`'s items 150 ms after the last key.
 */
function loadDebounced(
  c: SuggestionControls,
  cwdRef: RefObject<string | undefined>,
  timerRef: DebounceTimerRef,
  query: string,
  load: (path: string, fullQuery: string) => Promise<SuggestionItem[]>,
) {
  // Use the full text after the trigger (up to next space) instead of TipTap's
  // caret-dependent query, so moving the caret doesn't change results
  const fullQuery = c.getFullQuery(query);
  // Defer state updates out of TipTap's render cycle to avoid
  // "Cannot update a component while rendering a different component"
  queueMicrotask(() => {
    c.setSuggestionQuery(fullQuery);
    c.setSuggestionLoading(true);
  });
  // Return a promise that resolves with items after debounce
  return new Promise<SuggestionItem[]>((resolve) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      const path = cwdRef.current;
      if (!path) {
        c.setSuggestionLoading(false);
        resolve([]);
        return;
      }
      const items = await load(path, fullQuery);
      c.setSuggestionLoading(false);
      resolve(items);
    }, 150);
  });
}

// ── File suggestion config (@ trigger) ──
export function createFileSuggestion(
  c: SuggestionControls,
  sources: SuggestionSourceRefs,
  timerRef: DebounceTimerRef,
) {
  return {
    ...triggerOn('@'),
    items: ({ query }: { query: string }) =>
      loadDebounced(c, sources.cwdRef, timerRef, query, async (path, fullQuery) => {
        const result = await api.browseFiles(path, fullQuery || undefined);
        if (!result.isOk()) return [];
        c.setSuggestionTruncated(result.value.truncated);
        return result.value.files.map((f) => {
          const file = typeof f === 'string' ? { path: f, type: 'file' as const } : f;
          return {
            id: file.path,
            label: file.path,
            path: file.path,
            fileType: file.type,
            type: 'file' as const,
          };
        });
      }),
    command: ({ editor, range, props }: any) => {
      insertInlineNodeWithTrailingSpace(editor, range, 'fileMention', {
        id: props.path ?? props.id,
        label: (props.label as string).split('/').pop() ?? props.label,
        path: props.path ?? props.id,
        fileType: props.fileType ?? 'file',
      });
    },
    render: () => ({
      onStart: (props: any) => startMenu(c, 'file', props),
      onUpdate: (props: any) => updateMenu(c, props),
      onKeyDown: c.makeSuggestionKeyDown('file'),
      onExit: c.closeSuggestions,
    }),
  };
}

// ── Slash command suggestion config (/ trigger) ──
export function createSlashSuggestion(c: SuggestionControls, sources: SuggestionSourceRefs) {
  return {
    ...triggerOn('/'),
    items: ({ query }: { query: string }) => {
      const fullQuery = c.getFullQuery(query);
      // Defer state updates out of TipTap's render cycle
      queueMicrotask(() => c.setSuggestionQuery(fullQuery));
      // Lazy owners begin their fetch here; eager owners no-op. The reactive
      // effect in the owner hook rebuilds the menu once the resolved skills arrive.
      sources.onSlashOpenRef.current?.();
      const t0 = performance.now();
      const skills = sources.slashSkillsRef.current;
      const sdkCommands = sources.sdkSlashCommandsRef.current ?? [];
      const matched = buildSlashSuggestionItems({
        skills,
        sdkCommands,
        query: fullQuery,
        commandProvider: sources.commandProviderRef.current,
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
    command: ({ editor, range, props }: any) => {
      insertInlineNodeWithTrailingSpace(editor, range, 'slashCommand', {
        id: props.id,
        label: props.label,
      });
    },
    render: () => ({
      onStart: (props: any) => startMenu(c, 'slash', props),
      onUpdate: (props: any) => updateMenu(c, props),
      onKeyDown: c.makeSuggestionKeyDown('slash'),
      onExit: () => exitMenu(c),
    }),
  };
}

// ── Workflow suggestion config (>> trigger) ──
export function createWorkflowSuggestion(c: SuggestionControls, sources: SuggestionSourceRefs) {
  const { workflowsRef, workflowsLoadingRef } = sources;
  return {
    ...WORKFLOW_SUGGESTION_MATCH_OPTIONS,
    items: ({ query }: { query: string }) => {
      const fullQuery = c.getFullQuery(query);
      if (!fullQuery.startsWith('>')) return [];

      const workflowQuery = normalizeWorkflowQuery(fullQuery);
      queueMicrotask(() => {
        c.setSuggestionQuery(workflowQuery);
        c.setSuggestionLoading(
          Boolean(workflowsLoadingRef.current) && workflowsRef.current.length === 0,
        );
      });

      const t0 = performance.now();
      const matched = buildWorkflowSuggestionItems({
        workflows: workflowsRef.current,
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
    command: ({ editor, range, props }: any) => {
      const docSize = editor.state.doc.content.size;
      const safeRange = {
        from: Math.min(range.from, docSize),
        to: Math.min(range.to, docSize),
      };
      editor
        .chain()
        .focus()
        .insertContentAt(safeRange, { type: 'text', text: `>> ${props.label} ` })
        .run();
    },
    render: () => ({
      onStart: (props: any) => {
        c.triggerPosRef.current = props.range?.from ?? null;
        const fullQuery = c.getFullQuery(props.query ?? '');
        if (!fullQuery.startsWith('>')) {
          hideMenu(c);
          return;
        }
        c.setSuggestionType('workflow');
        c.setSuggestionItems(props.items);
        c.setSuggestionIndex(0);
        c.setSuggestionQuery(normalizeWorkflowQuery(fullQuery));
        c.setSuggestionRect(() => props.clientRect);
        c.suggestionCommandRef.current = props.command;
      },
      onUpdate: (props: any) => {
        const fullQuery = c.getFullQuery(props.query ?? '');
        if (!fullQuery.startsWith('>')) {
          hideMenu(c);
          return;
        }
        c.setSuggestionType('workflow');
        c.applySuggestionItems(props.items as SuggestionItem[]);
        c.setSuggestionQuery(normalizeWorkflowQuery(fullQuery));
        c.setSuggestionRect(() => props.clientRect);
        c.suggestionCommandRef.current = props.command;
      },
      onKeyDown: c.makeSuggestionKeyDown('workflow'),
      onExit: () => exitMenu(c),
    }),
  };
}

// ── Symbol suggestion config (# trigger) ──
export function createSymbolSuggestion(
  c: SuggestionControls,
  sources: SuggestionSourceRefs,
  timerRef: DebounceTimerRef,
) {
  return {
    ...triggerOn('#'),
    items: ({ query }: { query: string }) =>
      loadDebounced(c, sources.cwdRef, timerRef, query, async (path, fullQuery) => {
        // Support #file:symbol syntax
        const [fileScope, symbolQuery] = fullQuery.includes(':')
          ? [fullQuery.split(':')[0], fullQuery.split(':').slice(1).join(':')]
          : [undefined, fullQuery];

        const result = await api.searchSymbols(path, symbolQuery || undefined, fileScope);
        if (!result.isOk()) return [];
        const items = result.value.symbols.map((s) => ({
          id: `${s.filePath}:${s.name}:${s.line}`,
          label: s.containerName ? `${s.containerName}.${s.name}` : s.name,
          path: s.filePath,
          symbolKind: s.kind,
          symbolLine: s.line,
          symbolEndLine: s.endLine,
          type: 'symbol' as const,
        }));
        c.setSuggestionTruncated(result.value.truncated);

        // If not indexed yet, trigger indexing
        if (!result.value.indexed) {
          api.triggerSymbolIndex(path);
        }
        return items;
      }),
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
    render: () => ({
      onStart: (props: any) => startMenu(c, 'symbol', props),
      onUpdate: (props: any) => updateMenu(c, props),
      onKeyDown: c.makeSuggestionKeyDown('symbol'),
      onExit: c.closeSuggestions,
    }),
  };
}
