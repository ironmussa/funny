import type { ContextUsage } from './context-usage-types';

type Handler = (threadId: string, usage: ContextUsage) => void;

const handlers = new Set<Handler>();

export function onContextUsage(handler: Handler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

export function emitContextUsage(threadId: string, usage: ContextUsage): void {
  for (const h of handlers) h(threadId, usage);
}
