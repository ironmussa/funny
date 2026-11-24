import type { FileDiffSummary, FileStatus } from '@funny/shared';
import {
  useState,
  useMemo,
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type SetStateAction,
} from 'react';

import {
  isPathWithin,
  makeRelativePath,
  useCurrentProjectPath,
} from '@/components/tool-cards/utils';
import { api } from '@/lib/api';
import { parseDiffOld, parseDiffNew } from '@/lib/diff-parse';
import { computeUnifiedDiff } from '@/lib/snippet-unified-diff';
import { useThreadId } from '@/stores/thread-context';

interface EditChangeEntry {
  filePath: string;
  oldValue?: string;
  newValue?: string;
  rawDiff?: string;
  status: FileStatus;
}

type LoadedDiff = Omit<EditChangeEntry, 'filePath' | 'status'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeUnifiedDiff(filePath: string, diff: string): string {
  if (diff.startsWith('diff --git') || diff.startsWith('--- ')) return diff;
  return `--- a/${filePath}\n+++ b/${filePath}\n${diff}`;
}

/** The old and new file contents a unified diff describes, with the diff itself. */
function toDiffValues(rawDiff: string) {
  return { oldValue: parseDiffOld(rawDiff), newValue: parseDiffNew(rawDiff), rawDiff };
}

/** A diff viewer needs at least one hunk to produce visible rows. */
function hasUnifiedDiffHunk(diff: string | undefined): boolean {
  return !!diff && diff.split('\n').some((line) => line.startsWith('@@'));
}

/** The file status a change reports in `change[key]` (`type` in Claude edits, `kind` in Codex). */
function statusForChangeType(
  change: { type?: unknown; kind?: unknown },
  key: 'type' | 'kind',
): FileStatus {
  const type = change[key];
  if (type === 'add' || type === 'create') return 'added';
  if (type === 'delete' || type === 'remove') return 'deleted';
  if (type === 'move' || type === 'rename') return 'renamed';
  return 'modified';
}

function getEditChangeEntries(parsed: Record<string, unknown>): EditChangeEntry[] {
  const changes = parsed.changes;
  if (isRecord(changes)) {
    const entries: EditChangeEntry[] = [];
    for (const [filePath, rawChange] of Object.entries(changes)) {
      if (!filePath || !isRecord(rawChange)) continue;

      const status = statusForChangeType(rawChange, 'type');
      const unifiedDiff = rawChange.unified_diff;
      if (typeof unifiedDiff === 'string' && unifiedDiff.trim()) {
        const rawDiff = normalizeUnifiedDiff(filePath, unifiedDiff);
        entries.push({ filePath, ...toDiffValues(rawDiff), status });
        continue;
      }

      const content = rawChange.content;
      if (typeof content === 'string') {
        entries.push({
          filePath,
          oldValue: status === 'deleted' ? content : '',
          newValue: status === 'deleted' ? '' : content,
          status,
        });
      } else {
        // Keep entries without a captured patch so the client can still
        // request the live diff for legacy SDK events.
        entries.push({ filePath, status });
      }
    }
    if (entries.length > 0) return entries;
  }

  // `@openai/codex-sdk` reports a completed file change as a lightweight
  // array of `{ path, kind }` objects. It intentionally does not include the
  // patch text, so retain the paths here and load the actual diff on demand.
  if (Array.isArray(changes)) {
    return changes.flatMap((change) => {
      if (!isRecord(change) || typeof change.path !== 'string' || !change.path) return [];
      return [{ filePath: change.path, status: statusForChangeType(change, 'kind') }];
    });
  }

  const filePath = parsed.file_path;
  const oldString = parsed.old_string;
  const newString = parsed.new_string;
  if (typeof filePath !== 'string' || typeof newString !== 'string') return [];
  const oldValue = typeof oldString === 'string' ? oldString : '';
  if (oldValue === newString) return [];
  return [
    {
      filePath,
      oldValue,
      newValue: newString,
      status: typeof oldString === 'string' ? 'modified' : 'added',
    },
  ];
}

function getDialogDiffData(changeEntries: EditChangeEntry[]): {
  dialogFiles?: FileDiffSummary[];
  diffCache?: Map<string, string>;
} {
  const dialogFiles =
    changeEntries.length > 1
      ? changeEntries.map((entry) => ({
          path: entry.filePath,
          status: entry.status,
          staged: false,
        }))
      : undefined;
  const entriesWithRawDiff = changeEntries.filter((entry) => entry.rawDiff);
  const diffCache =
    entriesWithRawDiff.length > 0
      ? new Map(entriesWithRawDiff.map((entry) => [entry.filePath, entry.rawDiff!]))
      : undefined;
  return { dialogFiles, diffCache };
}

/** The change the card shows: the selected entry, with a loaded live diff taking precedence. */
interface ActiveChange {
  activeEntry: EditChangeEntry | undefined;
  filePath: string | undefined;
  diffFilePath: string | undefined;
  displayPath: string | undefined;
  oldString: string | undefined;
  newString: string | undefined;
  rawDiff: string | undefined;
  hasCapturedDiff: boolean;
}

/** The entry's texts, with a loaded live diff taking precedence over what the event captured. */
function withLoadedDiff(
  entry: EditChangeEntry | undefined,
  loadedDiffs: Map<string, LoadedDiff>,
): LoadedDiff {
  if (!entry) return {};
  const loaded = loadedDiffs.get(entry.filePath) ?? {};
  return {
    oldValue: loaded.oldValue ?? entry.oldValue,
    newValue: loaded.newValue ?? entry.newValue,
    rawDiff: loaded.rawDiff ?? entry.rawDiff,
  };
}

/** The relative path shown in the header, with the number of other files the edit touched. */
function formatDisplayPath(relativePath: string | undefined, entryCount: number) {
  if (relativePath === undefined) return undefined;
  return entryCount > 1 ? `${relativePath} +${entryCount - 1}` : relativePath;
}

function resolveActiveChange(
  changeEntries: EditChangeEntry[],
  requestedFilePath: string | null,
  loadedDiffs: Map<string, LoadedDiff>,
  projectPath: string | undefined,
): ActiveChange {
  const activeEntry =
    changeEntries.find((entry) => entry.filePath === requestedFilePath) ?? changeEntries[0];
  const filePath = activeEntry?.filePath;
  // Codex reports absolute paths when its working directory is absolute, while
  // the Git endpoint (and native Git implementation) expects a path relative
  // to the thread worktree.
  const diffFilePath = filePath ? makeRelativePath(filePath, projectPath) : undefined;
  const { oldValue, newValue, rawDiff } = withLoadedDiff(activeEntry, loadedDiffs);
  return {
    activeEntry,
    filePath,
    diffFilePath,
    displayPath: formatDisplayPath(diffFilePath, changeEntries.length),
    oldString: oldValue,
    newString: newValue,
    rawDiff,
    hasCapturedDiff: hasUnifiedDiffHunk(rawDiff),
  };
}

/** Whether the change has an old and a new text the inline diff can render. */
function isRenderableDiff({
  activeEntry,
  hasCapturedDiff,
  oldString,
  newString,
  rawDiff,
}: Pick<ActiveChange, 'activeEntry' | 'hasCapturedDiff' | 'oldString' | 'newString' | 'rawDiff'>) {
  return (
    !!activeEntry &&
    oldString != null &&
    newString != null &&
    oldString !== newString &&
    (!rawDiff || hasCapturedDiff)
  );
}

/** Whether the card must ask the runner for the file's live diff. */
function needsLiveDiff({
  hasCapturedDiff,
  oldString,
  newString,
  rawDiff,
}: Pick<ActiveChange, 'hasCapturedDiff' | 'oldString' | 'newString' | 'rawDiff'>) {
  return !hasCapturedDiff && (oldString == null || newString == null || !!rawDiff);
}

interface LiveDiffRequest extends ActiveChange {
  expanded: boolean;
  threadId: string | undefined;
  setLoadedDiffs: Dispatch<SetStateAction<Map<string, LoadedDiff>>>;
}

/**
 * SDK file-change entries contain paths but no patch content. Resolve only
 * expanded cards, so a long transcript does not issue a diff request for
 * every historical edit.
 */
function useLiveFileDiff({
  expanded,
  activeEntry,
  filePath,
  diffFilePath,
  hasCapturedDiff,
  oldString,
  newString,
  rawDiff,
  threadId,
  setLoadedDiffs,
}: LiveDiffRequest) {
  const requestedDiffPathsRef = useRef(new Set<string>());
  const [isDiffLoading, setIsDiffLoading] = useState(false);
  const [isDiffUnavailable, setIsDiffUnavailable] = useState(false);
  const [diffRequestVersion, setDiffRequestVersion] = useState(0);

  useEffect(() => {
    const needed = needsLiveDiff({ hasCapturedDiff, oldString, newString, rawDiff });
    if (!expanded || !activeEntry || !filePath || !diffFilePath || !needed) return;
    if (!threadId || requestedDiffPathsRef.current.has(filePath)) return;

    requestedDiffPathsRef.current.add(filePath);
    setIsDiffLoading(true);
    setIsDiffUnavailable(false);
    let cancelled = false;
    api.getFileDiff(threadId, diffFilePath, false, undefined, 'full').then(
      (result) => {
        const rawDiff = result.isOk() ? result.value.diff : '';
        const hasUsableDiff = hasUnifiedDiffHunk(rawDiff);
        if (!cancelled && hasUsableDiff) {
          setLoadedDiffs((current) => {
            const next = new Map(current);
            next.set(filePath, toDiffValues(rawDiff));
            return next;
          });
        }
        if (!cancelled) {
          setIsDiffUnavailable(!hasUsableDiff);
          setIsDiffLoading(false);
        }
      },
      () => {
        if (!cancelled) {
          setIsDiffUnavailable(true);
          setIsDiffLoading(false);
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [
    activeEntry,
    diffFilePath,
    diffRequestVersion,
    expanded,
    filePath,
    hasCapturedDiff,
    newString,
    oldString,
    rawDiff,
    threadId,
    setLoadedDiffs,
  ]);

  const retryDiff = useCallback((path: string) => {
    requestedDiffPathsRef.current.delete(path);
    setDiffRequestVersion((version) => version + 1);
  }, []);

  return { isDiffLoading, isDiffUnavailable, retryDiff };
}

/**
 * `snippetBaseLine` only feeds the rendered diff (computeUnifiedDiff /
 * baseLine prop), which itself is gated behind `diffMounted`. Reading the
 * file on mount for *every* card floods `/files/read` when a transcript has
 * hundreds of Edit/Write cards (e.g. an imported Claude Code session). Gate
 * the read on `diffMounted` so only cards whose diff is actually on-screen
 * fetch the file.
 */
function useSnippetBaseLine(
  diffMounted: boolean,
  filePath: string | undefined,
  newString: string | undefined,
  projectPath: string | undefined,
  rawDiff: string | undefined,
): number {
  const [snippetBaseLine, setSnippetBaseLine] = useState<number>(1);
  useEffect(() => {
    if (!diffMounted) return;
    if (rawDiff) return;
    if (!filePath || newString == null) return;
    // The runtime only serves files inside the thread's project/worktree; a
    // read outside it (e.g. `/tmp` scripts, Claude memory files) is a
    // guaranteed 403 that only adds console noise. Scratch threads have no
    // client-side base path, so they keep trying.
    if (projectPath && !isPathWithin(filePath, projectPath)) return;
    let cancelled = false;
    api.readFile(filePath).then((result) => {
      if (cancelled || result.isErr()) return;
      const content = result.value.content;
      const idx = content.indexOf(newString);
      if (idx < 0) return;
      const baseLine = content.slice(0, idx).split('\n').length;
      setSnippetBaseLine(baseLine);
    });
    return () => {
      cancelled = true;
    };
  }, [diffMounted, filePath, newString, projectPath, rawDiff]);
  return snippetBaseLine;
}

/** Everything the Edit card shows about its change: the active file, its diff and loading state. */
export function useEditFileDiff(
  parsed: Parameters<typeof getEditChangeEntries>[0],
  expanded: boolean,
  diffMounted: boolean,
) {
  const projectPath = useCurrentProjectPath();
  const threadId = useThreadId();
  const changeEntries = useMemo(() => getEditChangeEntries(parsed), [parsed]);
  const [requestedFilePath, setRequestedFilePath] = useState<string | null>(null);
  const [loadedDiffs, setLoadedDiffs] = useState<Map<string, LoadedDiff>>(() => new Map());
  const change = resolveActiveChange(changeEntries, requestedFilePath, loadedDiffs, projectPath);
  const { activeEntry, filePath, oldString, newString, rawDiff, hasCapturedDiff } = change;
  const { dialogFiles, diffCache } = useMemo(
    () => getDialogDiffData(changeEntries),
    [changeEntries],
  );

  const { isDiffLoading, isDiffUnavailable, retryDiff } = useLiveFileDiff({
    ...change,
    expanded,
    threadId,
    setLoadedDiffs,
  });
  const snippetBaseLine = useSnippetBaseLine(
    diffMounted,
    filePath,
    newString,
    projectPath,
    rawDiff,
  );

  const requestFullDiff = useCallback(
    async (
      path: string,
    ): Promise<{ oldValue: string; newValue: string; rawDiff?: string } | null> => {
      if (!threadId) return null;
      const result = await api.getFileDiff(
        threadId,
        makeRelativePath(path, projectPath),
        false,
        undefined,
        'full',
      );
      return result.isOk() ? toDiffValues(result.value.diff) : null;
    },
    [projectPath, threadId],
  );

  const hasDiff = useMemo(
    () => isRenderableDiff({ activeEntry, hasCapturedDiff, oldString, newString, rawDiff }),
    [activeEntry, hasCapturedDiff, oldString, newString, rawDiff],
  );

  const unifiedDiff = useMemo(() => {
    if (!hasDiff) return '';
    if (rawDiff) return rawDiff;
    return computeUnifiedDiff(oldString || '', newString || '', snippetBaseLine);
  }, [hasDiff, oldString, newString, rawDiff, snippetBaseLine]);

  return {
    projectPath,
    filePath,
    displayPath: change.displayPath,
    oldString,
    newString,
    hasDiff,
    unifiedDiff,
    snippetBaseLine,
    dialogFiles,
    diffCache,
    setRequestedFilePath,
    isDiffLoading,
    isDiffUnavailable,
    retryDiff,
    requestFullDiff,
  };
}

/**
 * Mounts the inline diff only once its slot nears the viewport. Returns the
 * slot's callback ref and whether the diff may render.
 */
export function useDiffMountOnVisible(expanded: boolean) {
  const [diffMounted, setDiffMounted] = useState(false);
  const diffObserverRef = useRef<IntersectionObserver | null>(null);
  const diffMountFrameRef = useRef<number | null>(null);

  const diffSlotRef = useCallback(
    (el: HTMLDivElement | null) => {
      diffObserverRef.current?.disconnect();
      diffObserverRef.current = null;
      if (diffMountFrameRef.current != null) {
        window.cancelAnimationFrame(diffMountFrameRef.current);
        diffMountFrameRef.current = null;
      }

      if (!el || !expanded || diffMounted) return;
      if (typeof IntersectionObserver === 'undefined') {
        setDiffMounted(true);
        return;
      }

      // IntersectionObserver can miss a newly expanded element inside the
      // transcript's nested scroller. Check its viewport position on the next
      // frame as a fallback so the card cannot remain a blank placeholder.
      diffMountFrameRef.current = window.requestAnimationFrame(() => {
        diffMountFrameRef.current = null;
        const rect = el.getBoundingClientRect();
        const withinViewportMargin =
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom >= -600 &&
          rect.top <= window.innerHeight + 600;
        if (withinViewportMargin) setDiffMounted(true);
      });

      const io = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            setDiffMounted(true);
            io.disconnect();
          }
        },
        { rootMargin: '600px 0px' },
      );
      diffObserverRef.current = io;
      // The observer is disconnected on intersection, callback-ref replacement, and component unmount.
      // react-doctor-disable-next-line effect-needs-cleanup
      io.observe(el);
    },
    [diffMounted, expanded],
  );

  useEffect(
    () => () => {
      diffObserverRef.current?.disconnect();
      if (diffMountFrameRef.current != null) {
        window.cancelAnimationFrame(diffMountFrameRef.current);
      }
    },
    [],
  );

  return { diffMounted, diffSlotRef };
}
