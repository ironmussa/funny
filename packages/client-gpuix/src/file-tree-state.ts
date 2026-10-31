import { createStore, type ClientPlatform, type StoreApi } from '@funny/client-core';
import type { Project, Thread } from '@funny/shared';

import { nativeJsonRequest } from './services/native-api';

export const NATIVE_FILE_TREE_MAX_FILES = 10_000;

export interface NativeFileTreeTarget {
  path: string;
}

export interface NativeFileTreeState {
  targetKey: string | null;
  basePath: string | null;
  files: string[];
  loading: boolean;
  truncated: boolean;
  error: string | null;
  loaded: boolean;
  /** The thread has no directory the server can list (scratch, or a worktree not created yet). */
  unavailable: boolean;
}

const initialState: NativeFileTreeState = {
  targetKey: null,
  basePath: null,
  files: [],
  loading: false,
  truncated: false,
  error: null,
  loaded: false,
  unavailable: false,
};

export function resolveNativeFileTreeTarget(
  thread: Thread,
  project?: Project,
): NativeFileTreeTarget | null {
  if (thread.worktreePath) return { path: thread.worktreePath };
  if (thread.mode === 'worktree' || thread.isScratch || !project?.path) return null;
  return { path: project.path };
}

function targetKey(target: NativeFileTreeTarget): string {
  return `path:${target.path}`;
}

type BrowseEntry = string | { path?: unknown; type?: unknown };

/** `/browse/files` returns bare paths or `{ path, type }` entries; the tree derives folders itself. */
function filePaths(entries: unknown[]): string[] | null {
  const paths: string[] = [];
  for (const entry of entries as BrowseEntry[]) {
    if (typeof entry === 'string') {
      paths.push(entry);
    } else if (entry && typeof entry === 'object' && typeof entry.path === 'string') {
      if (entry.type !== 'folder') paths.push(entry.path);
    } else {
      return null;
    }
  }
  return paths;
}

export class NativeFileTreeService {
  readonly state: StoreApi<NativeFileTreeState>;
  private requestSequence = 0;
  private currentTarget: NativeFileTreeTarget | null = null;

  constructor(
    private readonly options: {
      platform: ClientPlatform;
      clientOrigin: string;
    },
  ) {
    this.state = createStore<NativeFileTreeState>(() => ({ ...initialState }));
  }

  loadForThread(thread: Thread, project?: Project, force = false): Promise<void> {
    const target = resolveNativeFileTreeTarget(thread, project);
    if (!target) {
      this.requestSequence += 1;
      this.currentTarget = null;
      this.state.setState({ ...initialState, unavailable: true });
      return Promise.resolve();
    }
    const key = targetKey(target);
    const current = this.state.getState();
    if (!force && current.targetKey === key && (current.loading || current.loaded)) {
      return Promise.resolve();
    }
    return this.load(target);
  }

  refresh(): Promise<void> {
    return this.currentTarget ? this.load(this.currentTarget) : Promise.resolve();
  }

  clear(): void {
    this.requestSequence += 1;
    this.currentTarget = null;
    this.state.setState({ ...initialState });
  }

  private async load(target: NativeFileTreeTarget): Promise<void> {
    const sequence = ++this.requestSequence;
    const key = targetKey(target);
    this.currentTarget = target;
    const current = this.state.getState();
    this.state.setState({
      ...initialState,
      targetKey: key,
      loading: true,
      files: current.targetKey === key ? current.files : [],
      basePath: current.targetKey === key ? current.basePath : null,
    });
    try {
      const params = new URLSearchParams({
        path: target.path,
        limit: String(NATIVE_FILE_TREE_MAX_FILES),
      });
      const response = await nativeJsonRequest<{ files?: unknown; truncated?: unknown }>({
        ...this.options,
        path: `/browse/files?${params.toString()}`,
      });
      if (sequence !== this.requestSequence) return;
      const files = Array.isArray(response.files) ? filePaths(response.files) : null;
      if (!files) throw new Error('File index response is invalid');
      this.state.setState({
        targetKey: key,
        basePath: target.path,
        files: files.slice(0, NATIVE_FILE_TREE_MAX_FILES),
        loading: false,
        truncated: response.truncated === true || files.length > NATIVE_FILE_TREE_MAX_FILES,
        error: null,
        loaded: true,
      });
    } catch (error) {
      if (sequence !== this.requestSequence) return;
      this.options.platform.diagnostics.report({
        capability: 'transport',
        operation: 'file-tree.request',
        error,
      });
      this.state.setState({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
