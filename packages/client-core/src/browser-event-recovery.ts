import { create } from '@bufbuild/protobuf';
import { CursorSchema, type Cursor, type ScopeReference } from '@funny/shared/browser-v1/common';
import type { ApplicationEvent } from '@funny/shared/browser-v1/events';

interface ScopeState {
  lastEventId: string;
  lastSequence: bigint;
  lastRevision: bigint;
  scope: ScopeReference;
}

export type BrowserEventAcceptance =
  | { kind: 'accepted' }
  | { kind: 'duplicate' }
  | { kind: 'stale' }
  | { kind: 'gap'; scope: ScopeReference };

function scopeKey(scope: ScopeReference): string {
  return `${scope.kind}:${scope.parentId ?? ''}:${scope.id}`;
}

export class BrowserEventRecoveryState {
  private readonly scopes = new Map<string, ScopeState>();
  private readonly eventIds = new Map<string, true>();

  constructor(private readonly maxEventIds = 10_000) {}

  acceptCursor(cursor: Cursor): void {
    if (!cursor.scope) return;
    const key = scopeKey(cursor.scope);
    const current = this.scopes.get(key);
    if (current && current.lastRevision > cursor.lastRevision) return;
    this.scopes.set(key, {
      scope: cursor.scope,
      lastEventId: cursor.lastEventId,
      lastSequence: cursor.lastSequence,
      lastRevision: cursor.lastRevision,
    });
  }

  accept(event: ApplicationEvent): BrowserEventAcceptance {
    const metadata = event.metadata;
    if (!metadata?.scope || !metadata.eventId) return { kind: 'stale' };
    if (this.eventIds.has(metadata.eventId)) return { kind: 'duplicate' };
    const key = scopeKey(metadata.scope);
    const current = this.scopes.get(key);
    if (current && metadata.sequence > current.lastSequence + 1n) {
      return { kind: 'gap', scope: metadata.scope };
    }
    this.rememberEventId(metadata.eventId);
    if (current && metadata.revision <= current.lastRevision) return { kind: 'stale' };
    this.scopes.set(key, {
      scope: metadata.scope,
      lastEventId: metadata.eventId,
      lastSequence: metadata.sequence,
      lastRevision: metadata.revision,
    });
    return { kind: 'accepted' };
  }

  cursors(): Cursor[] {
    return [...this.scopes.values()].map((state) =>
      create(CursorSchema, {
        scope: state.scope,
        lastEventId: state.lastEventId,
        lastSequence: state.lastSequence,
        lastRevision: state.lastRevision,
      }),
    );
  }

  private rememberEventId(eventId: string): void {
    this.eventIds.set(eventId, true);
    if (this.eventIds.size <= this.maxEventIds) return;
    const oldest = this.eventIds.keys().next().value;
    if (oldest) this.eventIds.delete(oldest);
  }
}
