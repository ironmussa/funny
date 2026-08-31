import { createStore, type ClientPlatform, type StoreApi } from '@funny/client-core';
import type { Project, Thread } from '@funny/shared';

import { nativeJsonRequest } from './services/native-api';

export const NATIVE_FILE_TREE_MAX_FILES = 10_000;

export type NativeFileTreeTarget = { path: string } | { threadId: string };

export interface NativeFileTreeState {
  targetKey: string | null;
  basePath: string | null;
  files: string[];
  loading: boolean;
  truncated: boolean;
  error: string | null;
  version: number | null;
}

const initialState: NativeFileTreeState = {
  targetKey: null,
  basePath: null,
  files: [],
  loading: false,
  truncated: false,
  error: null,
  version: null,
};

export function resolveNativeFileTreeTarget(
  thread: Thread,
  project?: Project,
): NativeFileTreeTarget {
  if (thread.worktreePath) return { path: thread.worktreePath };
  if (thread.mode === 'worktree' || thread.isScratch || !project?.path) {
    return { threadId: thread.id };
  }
  return { path: project.path };
}

function targetKey(target: NativeFileTreeTarget): string {
  return 'path' in target ? `path:${target.path}` : `thread:${target.threadId}`;
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
    const key = targetKey(target);
    const current = this.state.getState();
    if (!force && current.targetKey === key && (current.loading || current.version !== null)) {
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
      const query =
        'path' in target
          ? `path=${encodeURIComponent(target.path)}`
          : `threadId=${encodeURIComponent(target.threadId)}`;
      const response = await nativeJsonRequest<{
        files?: unknown;
        version?: unknown;
        basePath?: unknown;
      }>({
        ...this.options,
        path: `/browse/files/index?${query}`,
      });
      if (sequence !== this.requestSequence) return;
      if (
        !Array.isArray(response.files) ||
        response.files.some((path) => typeof path !== 'string')
      ) {
        throw new Error('File index response is invalid');
      }
      const truncated = response.files.length > NATIVE_FILE_TREE_MAX_FILES;
      this.state.setState({
        targetKey: key,
        basePath:
          typeof response.basePath === 'string'
            ? response.basePath
            : 'path' in target
              ? target.path
              : null,
        files: (response.files as string[]).slice(0, NATIVE_FILE_TREE_MAX_FILES),
        loading: false,
        truncated,
        error: null,
        version:
          typeof response.version === 'number' && Number.isFinite(response.version)
            ? response.version
            : 0,
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
