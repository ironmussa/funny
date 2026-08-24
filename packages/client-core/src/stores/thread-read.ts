import type { DiagnosticService, StorageService, Unsubscribe } from '../platform';
import { createPersistedValue } from './persisted-value';
import { createStore, type StoreApi } from './vanilla-store';

export const THREAD_READ_STORAGE_KEY = 'funny:thread-read-at';

export interface ThreadReadState {
  readAt: Record<string, string>;
  markRead(threadId: string, completedAt?: string | null): void;
}

export interface PortableStore<T> extends StoreApi<T> {
  dispose(): void;
}

function decodeReadAt(raw: string): Record<string, string> {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Thread read markers must be an object');
  }
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

export function createThreadReadStore(options: {
  storage: StorageService;
  diagnostics: DiagnosticService;
  now?: () => string;
}): PortableStore<ThreadReadState> {
  const persisted = createPersistedValue({
    storage: options.storage,
    diagnostics: options.diagnostics,
    key: THREAD_READ_STORAGE_KEY,
    fallback: () => ({}),
    decode: decodeReadAt,
    encode: JSON.stringify,
    removeMalformed: true,
  });
  const store = createStore<ThreadReadState>((set, get) => ({
    readAt: persisted.read(),
    markRead(threadId, completedAt) {
      const stamp = completedAt ?? options.now?.() ?? new Date().toISOString();
      const current = get().readAt[threadId];
      if (current && current >= stamp) return;
      const readAt = { ...get().readAt, [threadId]: stamp };
      set({ readAt });
      persisted.write(readAt);
    },
  }));
  const unsubscribe: Unsubscribe = persisted.subscribe((readAt) => store.setState({ readAt }));
  return Object.assign(store, { dispose: unsubscribe });
}

export function isThreadUnread(
  readAt: Record<string, string>,
  threadId: string,
  completedAt?: string | null,
): boolean {
  if (!completedAt) return false;
  const last = readAt[threadId];
  return !last || last < completedAt;
}
