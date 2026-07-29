import FileSearchWorker from '@/workers/file-search.worker.ts?worker';

import { trackWorker } from './worker-diagnostics';

export interface FileSearchMatch {
  path: string;
  score: number;
  indices: number[];
}

export interface FileSearchResult {
  matches: FileSearchMatch[];
  truncated: boolean;
  total: number;
}

interface SearchResultMessage {
  type: 'searchResult';
  requestId: number;
  matches: FileSearchMatch[];
  truncated: boolean;
  total: number;
}

/**
 * Stateful client for the file-search worker. One instance owns one worker
 * and one in-flight request — newer searches preempt older ones via
 * `requestId`. The worker keeps its own copy of the file index so we don't
 * pay serialisation cost on every keystroke.
 */
export class FileSearchWorkerClient {
  private worker: Worker;
  private nextRequestId = 1;
  private pendingResolve: ((result: FileSearchResult) => void) | null = null;
  private pendingRequestId = 0;
  private indexedKey: string | null = null;

  constructor() {
    // Tracked because this isolate's heap is invisible to `performance.memory`.
    this.worker = trackWorker('file-search', new FileSearchWorker());
    this.worker.addEventListener('message', this.onMessage);
  }

  /** Push a new file list to the worker. Cheap if the key matches the previous one. */
  setIndex(key: string, files: string[], recents: string[] = []): void {
    if (this.indexedKey === key) {
      // Still update — file list may have changed; recents may have changed
    }
    this.indexedKey = key;
    this.worker.postMessage({ type: 'setIndex', files, recents });
  }

  search(query: string, limit = 100): Promise<FileSearchResult> {
    const requestId = ++this.nextRequestId;

    // Reject the previous in-flight promise so callers can cleanup
    if (this.pendingResolve) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      resolve({ matches: [], truncated: false, total: 0 });
    }

    return new Promise((resolve) => {
      this.pendingResolve = resolve;
      this.pendingRequestId = requestId;
      this.worker.postMessage({ type: 'search', requestId, query, limit });
    });
  }

  private onMessage = (e: MessageEvent<SearchResultMessage>): void => {
    const msg = e.data;
    if (msg.type !== 'searchResult') return;
    if (msg.requestId !== this.pendingRequestId) return; // stale
    const resolve = this.pendingResolve;
    this.pendingResolve = null;
    if (resolve) {
      resolve({ matches: msg.matches, truncated: msg.truncated, total: msg.total });
    }
  };

  dispose(): void {
    this.worker.removeEventListener('message', this.onMessage);
    this.worker.terminate();
    this.pendingResolve = null;
  }
}
