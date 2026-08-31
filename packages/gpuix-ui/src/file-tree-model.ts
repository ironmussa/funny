export interface NativeFileTreeRow {
  kind: 'folder' | 'file';
  path: string;
  name: string;
  depth: number;
}

interface FolderNode {
  folders: Map<string, FolderNode>;
  files: Map<string, string>;
}

function createFolderNode(): FolderNode {
  return { folders: new Map(), files: new Map() };
}

export function normalizeFilePaths(paths: readonly string[]): string[] {
  const normalized = new Set<string>();
  for (const path of paths) {
    const clean = path.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
    if (clean && !clean.split('/').includes('..')) normalized.add(clean);
  }
  return [...normalized].sort((left, right) => left.localeCompare(right));
}

export function filterFilePaths(paths: readonly string[], query: string): string[] {
  const normalized = normalizeFilePaths(paths);
  const needle = query.trim().toLocaleLowerCase();
  return needle
    ? normalized.filter((path) => path.toLocaleLowerCase().includes(needle))
    : normalized;
}

export function collectFileTreeFolders(paths: readonly string[]): Set<string> {
  const folders = new Set<string>();
  for (const path of normalizeFilePaths(paths)) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      folders.add(parts.slice(0, index).join('/'));
    }
  }
  return folders;
}

export function buildFileTreeRows(
  paths: readonly string[],
  collapsedFolders: ReadonlySet<string>,
): NativeFileTreeRow[] {
  return buildNormalizedFileTreeRows(normalizeFilePaths(paths), collapsedFolders);
}

export function buildNormalizedFileTreeRows(
  paths: readonly string[],
  collapsedFolders: ReadonlySet<string>,
): NativeFileTreeRow[] {
  const root = createFolderNode();
  for (const path of paths) {
    const parts = path.split('/');
    const fileName = parts.pop();
    if (!fileName) continue;
    let folder = root;
    for (const part of parts) {
      const existing = folder.folders.get(part);
      if (existing) folder = existing;
      else {
        const created = createFolderNode();
        folder.folders.set(part, created);
        folder = created;
      }
    }
    folder.files.set(fileName, path);
  }

  const rows: NativeFileTreeRow[] = [];
  appendFolderRows(root, '', 0, collapsedFolders, rows);
  return rows;
}

function appendFolderRows(
  node: FolderNode,
  parentPath: string,
  depth: number,
  collapsedFolders: ReadonlySet<string>,
  rows: NativeFileTreeRow[],
): void {
  const folderNames = [...node.folders.keys()].sort((left, right) => left.localeCompare(right));
  for (const name of folderNames) {
    const path = parentPath ? `${parentPath}/${name}` : name;
    rows.push({ kind: 'folder', path, name, depth });
    if (!collapsedFolders.has(path)) {
      appendFolderRows(node.folders.get(name)!, path, depth + 1, collapsedFolders, rows);
    }
  }
  const files = [...node.files.entries()].sort(([left], [right]) => left.localeCompare(right));
  for (const [name, path] of files) rows.push({ kind: 'file', path, name, depth });
}
