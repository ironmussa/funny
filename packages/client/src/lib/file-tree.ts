import type { FileDiffSummary } from '@funny/shared';

export type TreeRow =
  | {
      kind: 'folder';
      path: string;
      label: string;
      depth: number;
      fileCount: number;
      additions: number;
      deletions: number;
    }
  | { kind: 'file'; file: FileDiffSummary; depth: number }
  | {
      kind: 'submodule-status';
      submodulePath: string;
      depth: number;
      state: 'loading' | 'error' | 'empty';
      message?: string;
    };

interface FolderNode {
  children: Map<string, FolderNode>;
  files: FileDiffSummary[];
}

/** Build a flat row list for virtualization. */
export function buildTreeRows(
  diffs: FileDiffSummary[],
  collapsed: Set<string>,
  submoduleExpansions?: Map<string, FileDiffSummary[]>,
  submoduleStates?: Map<string, { state: 'loading' | 'error' | 'empty'; message?: string }>,
  expandedSubmodules?: Set<string>,
): TreeRow[] {
  const root: FolderNode = { children: new Map(), files: [] };
  for (const file of diffs) {
    const parts = file.path.split('/');
    parts.pop();
    let node = root;
    for (const part of parts) {
      if (!node.children.has(part)) {
        node.children.set(part, { children: new Map(), files: [] });
      }
      node = node.children.get(part)!;
    }
    node.files.push(file);
  }

  function aggregateStats(node: FolderNode) {
    let fileCount = node.files.length;
    let additions = node.files.reduce((total, file) => total + (file.additions ?? 0), 0);
    let deletions = node.files.reduce((total, file) => total + (file.deletions ?? 0), 0);
    for (const child of node.children.values()) {
      const stats = aggregateStats(child);
      fileCount += stats.fileCount;
      additions += stats.additions;
      deletions += stats.deletions;
    }
    return { fileCount, additions, deletions };
  }

  const rows: TreeRow[] = [];

  function appendSubmoduleChildren(file: FileDiffSummary, depth: number) {
    const inner = submoduleExpansions?.get(file.path);
    const state = submoduleStates?.get(file.path);
    if (inner && inner.length > 0) {
      const prefixed = inner.map((child) => ({ ...child, path: `${file.path}/${child.path}` }));
      const innerRows = buildTreeRows(prefixed, collapsed, submoduleExpansions, submoduleStates);
      for (const row of innerRows) rows.push({ ...row, depth: row.depth + depth + 1 });
    } else if (state) {
      rows.push({
        kind: 'submodule-status',
        submodulePath: file.path,
        depth: depth + 1,
        state: state.state,
        message: state.message,
      });
    }
  }

  function flatten(node: FolderNode, depth: number, pathPrefix: string) {
    const sortedFolders = Array.from(node.children.entries()).toSorted(([a], [b]) =>
      a.localeCompare(b),
    );
    for (const [name, child] of sortedFolders) {
      let compactedName = name;
      let current = child;
      let currentPath = pathPrefix ? `${pathPrefix}/${name}` : name;
      while (current.files.length === 0 && current.children.size === 1) {
        const [nextName, nextChild] = [...current.children.entries()][0];
        compactedName += `/${nextName}`;
        currentPath += `/${nextName}`;
        current = nextChild;
      }
      const stats = aggregateStats(current);
      rows.push({
        kind: 'folder',
        path: currentPath,
        label: compactedName,
        depth,
        fileCount: stats.fileCount,
        additions: stats.additions,
        deletions: stats.deletions,
      });
      if (!collapsed.has(currentPath)) flatten(current, depth + 1, currentPath);
    }
    for (const file of node.files.sort((a, b) => a.path.localeCompare(b.path))) {
      rows.push({ kind: 'file', file, depth });
      if (file.kind === 'submodule' && expandedSubmodules?.has(file.path)) {
        appendSubmoduleChildren(file, depth);
      }
    }
  }

  flatten(root, 0, '');
  return rows;
}

export function collectAllFolderPaths(files: FileDiffSummary[]): Set<string> {
  const rows = buildTreeRows(files, new Set());
  const paths = new Set<string>();
  for (const row of rows) {
    if (row.kind === 'folder') paths.add(row.path);
  }
  return paths;
}
