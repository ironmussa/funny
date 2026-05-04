import type { FileDiffSummary } from '@funny/shared';
import { useCallback, useMemo, useState } from 'react';

import { buildTreeRows, collectAllFolderPaths, type TreeRow } from '@/components/FileTree';
import { gitApi } from '@/lib/api/git';

export interface UseFileTreeStateResult {
  // Filtered list (search-aware)
  filteredDiffs: FileDiffSummary[];

  // Folder collapse/expand
  collapsedFolders: Set<string>;
  toggleFolder: (folderPath: string) => void;
  handleCollapseAllFolders: () => void;
  handleExpandAllFolders: () => void;
  hasFolders: boolean;
  allFoldersCollapsed: boolean;

  // Submodules
  expandedSubmodules: Set<string>;
  submoduleExpansions: Map<string, FileDiffSummary[]>;
  toggleSubmodule: (submodulePath: string) => Promise<void>;
  /** Resolve a composite path like `<submodule>/<innerPath>` to its inner entry. */
  resolveSubmoduleEntry: (
    filePath: string,
  ) => { submodulePath: string; innerPath: string; staged: boolean } | null;

  // Derived row list (passed wholesale to <ChangesFilesPanel/>)
  treeRows: TreeRow[];

  // Visible (non-collapsed) file paths — used to compute selected/total counts
  visibleFiles: Extract<TreeRow, { kind: 'file' }>[];
  visiblePaths: Set<string>;
}

interface UseFileTreeStateArgs {
  summaries: FileDiffSummary[];
  fileSearch: string;
  fileSearchCaseSensitive: boolean;
  effectiveThreadId: string | undefined;
  projectModeId: string | null;
}

/**
 * Owns the file-tree UI state for ReviewPane's Changes tab: folder collapse,
 * submodule expand-on-demand (with lazy fetch of inner diffs), and the derived
 * row list consumed by the virtualized renderer.
 *
 * Extracted from ReviewPane.tsx as part of the god-file split — see
 * .claude/plans/reviewpane-split.md.
 */
export function useFileTreeState({
  summaries,
  fileSearch,
  fileSearchCaseSensitive,
  effectiveThreadId,
  projectModeId,
}: UseFileTreeStateArgs): UseFileTreeStateResult {
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [expandedSubmodules, setExpandedSubmodules] = useState<Set<string>>(new Set());
  const [submoduleExpansions, setSubmoduleExpansions] = useState<Map<string, FileDiffSummary[]>>(
    new Map(),
  );
  const [submoduleStates, setSubmoduleStates] = useState<
    Map<string, { state: 'loading' | 'error' | 'empty'; message?: string }>
  >(new Map());

  // Resolve a path to the (submodule, inner-relative-path, inner-summary) triple
  // when it belongs to an expanded submodule. Inner files use composite paths
  // like `<submodule>/<innerPath>` and are not present in `summaries`, so the
  // lookup also has to consult `submoduleExpansions` to find their `staged`
  // flag and to route diff requests to the nested repo.
  const resolveSubmoduleEntry = useCallback(
    (filePath: string): { submodulePath: string; innerPath: string; staged: boolean } | null => {
      for (const [submodulePath, inner] of submoduleExpansions) {
        const prefix = `${submodulePath}/`;
        if (!filePath.startsWith(prefix)) continue;
        const innerPath = filePath.slice(prefix.length);
        const innerSummary = inner.find((f) => f.path === innerPath);
        if (!innerSummary) continue;
        return { submodulePath, innerPath, staged: innerSummary.staged };
      }
      return null;
    },
    [submoduleExpansions],
  );

  const filteredDiffs = useMemo(() => {
    if (!fileSearch) return summaries;
    if (fileSearchCaseSensitive) {
      return summaries.filter((d) => d.path.includes(fileSearch));
    }
    const query = fileSearch.toLowerCase();
    return summaries.filter((d) => d.path.toLowerCase().includes(query));
  }, [summaries, fileSearch, fileSearchCaseSensitive]);

  const toggleSubmodule = useCallback(
    async (submodulePath: string) => {
      const currentlyExpanded = expandedSubmodules.has(submodulePath);
      setExpandedSubmodules((prev) => {
        const next = new Set(prev);
        if (currentlyExpanded) next.delete(submodulePath);
        else next.add(submodulePath);
        return next;
      });
      if (currentlyExpanded) return;
      // Fetch only when expanding and we haven't loaded it yet.
      if (submoduleExpansions.has(submodulePath)) return;
      setSubmoduleStates((prev) => {
        const next = new Map(prev);
        next.set(submodulePath, { state: 'loading' });
        return next;
      });
      try {
        const result = effectiveThreadId
          ? await gitApi.getSubmoduleDiffSummary(effectiveThreadId, submodulePath)
          : projectModeId
            ? await gitApi.projectSubmoduleDiffSummary(projectModeId, submodulePath)
            : null;
        if (!result) return;
        if (result.isErr()) {
          setSubmoduleStates((prev) => {
            const next = new Map(prev);
            next.set(submodulePath, { state: 'error', message: result.error.message });
            return next;
          });
          return;
        }
        const res = result.value;
        if (res.files.length === 0) {
          setSubmoduleStates((prev) => {
            const next = new Map(prev);
            next.set(submodulePath, { state: 'empty' });
            return next;
          });
        } else {
          setSubmoduleExpansions((prev) => {
            const next = new Map(prev);
            next.set(submodulePath, res.files);
            return next;
          });
          setSubmoduleStates((prev) => {
            const next = new Map(prev);
            next.delete(submodulePath);
            return next;
          });
        }
      } catch (e) {
        setSubmoduleStates((prev) => {
          const next = new Map(prev);
          next.set(submodulePath, {
            state: 'error',
            message: e instanceof Error ? e.message : String(e),
          });
          return next;
        });
      }
    },
    [expandedSubmodules, submoduleExpansions, effectiveThreadId, projectModeId],
  );

  const treeRows = useMemo(
    () =>
      buildTreeRows(
        filteredDiffs,
        collapsedFolders,
        submoduleExpansions,
        submoduleStates,
        expandedSubmodules,
      ),
    [filteredDiffs, collapsedFolders, submoduleExpansions, submoduleStates, expandedSubmodules],
  );

  const toggleFolder = useCallback((folderPath: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) next.delete(folderPath);
      else next.add(folderPath);
      return next;
    });
  }, []);

  const handleCollapseAllFolders = useCallback(() => {
    setCollapsedFolders(collectAllFolderPaths(filteredDiffs));
  }, [filteredDiffs]);

  const handleExpandAllFolders = useCallback(() => {
    setCollapsedFolders(new Set());
  }, []);

  const hasFolders = useMemo(() => treeRows.some((r) => r.kind === 'folder'), [treeRows]);
  const allFoldersCollapsed = useMemo(() => {
    if (!hasFolders) return false;
    return treeRows.every((r) => r.kind !== 'folder' || collapsedFolders.has(r.path));
  }, [treeRows, collapsedFolders, hasFolders]);

  const visibleFiles = useMemo(
    () => treeRows.filter((r): r is Extract<typeof r, { kind: 'file' }> => r.kind === 'file'),
    [treeRows],
  );
  const visiblePaths = useMemo(() => new Set(visibleFiles.map((r) => r.file.path)), [visibleFiles]);

  return {
    filteredDiffs,
    collapsedFolders,
    toggleFolder,
    handleCollapseAllFolders,
    handleExpandAllFolders,
    hasFolders,
    allFoldersCollapsed,
    expandedSubmodules,
    submoduleExpansions,
    toggleSubmodule,
    resolveSubmoduleEntry,
    treeRows,
    visibleFiles,
    visiblePaths,
  };
}
