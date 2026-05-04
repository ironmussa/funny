type UnauthorizedHandler = (path: string) => void;

const handlers = new Set<UnauthorizedHandler>();

export function onUnauthorized(handler: UnauthorizedHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

export function emitUnauthorized(path: string): void {
  for (const h of handlers) h(path);
}
