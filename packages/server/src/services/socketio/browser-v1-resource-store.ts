import { createHash, randomUUID } from 'node:crypto';

interface BrowserV1Resource {
  id: string;
  userId: string;
  bytes: Uint8Array;
  mediaType: string;
  entityTag: string;
  expiresAt: Date;
}

export class BrowserV1ResourceStore {
  private readonly resources = new Map<string, BrowserV1Resource>();
  private totalBytes = 0;

  constructor(
    private readonly options: {
      maxResourceBytes: number;
      maxTotalBytes: number;
      retentionMs: number;
      now?: () => number;
      id?: () => string;
    },
  ) {}

  put(userId: string, bytes: Uint8Array, mediaType: string): BrowserV1Resource | null {
    this.prune();
    if (bytes.byteLength > this.options.maxResourceBytes) return null;
    while (this.totalBytes + bytes.byteLength > this.options.maxTotalBytes) {
      const oldestId = this.resources.keys().next().value as string | undefined;
      if (!oldestId) return null;
      this.remove(oldestId);
    }
    const id = this.options.id?.() ?? randomUUID();
    const resource: BrowserV1Resource = {
      id,
      userId,
      bytes,
      mediaType,
      entityTag: `"${createHash('sha256').update(bytes).digest('hex')}"`,
      expiresAt: new Date(this.now() + this.options.retentionMs),
    };
    this.resources.set(id, resource);
    this.totalBytes += bytes.byteLength;
    return resource;
  }

  get(id: string, userId: string): BrowserV1Resource | undefined {
    this.prune();
    const resource = this.resources.get(id);
    return resource?.userId === userId ? resource : undefined;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private prune(): void {
    const now = this.now();
    for (const [id, resource] of this.resources) {
      if (resource.expiresAt.getTime() <= now) this.remove(id);
    }
  }

  private remove(id: string): void {
    const resource = this.resources.get(id);
    if (!resource) return;
    this.totalBytes -= resource.bytes.byteLength;
    this.resources.delete(id);
  }
}

export const browserV1ResourceStore = new BrowserV1ResourceStore({
  maxResourceBytes: 8 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  retentionMs: 30_000,
});
