/**
 * Signals that a loaded commit history is out of date for a reason the git
 * status fingerprint cannot see, e.g. the runtime found a branch's PR after it
 * served the graph without its badge.
 *
 * Keyed like the review pane: thread-mode history by thread id, project-mode
 * history by project id.
 */
type Listener = (key: string) => void;

const listeners = new Set<Listener>();

export function notifyGitHistoryChanged(key: string): void {
  for (const listener of listeners) listener(key);
}

export function subscribeGitHistoryChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
