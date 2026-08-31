import {
  createThreadCommandController,
  type StoreApi,
  type ThreadCommandPorts,
  type ThreadWorkspaceState,
} from '@funny/client-core';

import type { NativeClientComposition } from '../platform/composition';
import { nativeJsonRequest } from './native-api';

export function createNativeThreadCommands(options: {
  composition: NativeClientComposition;
  workspace: StoreApi<ThreadWorkspaceState>;
}) {
  const request = <T>(path: string, body?: unknown): Promise<T> =>
    nativeJsonRequest<T>({
      platform: options.composition.platform,
      path,
      method: 'POST',
      body,
      clientOrigin: options.composition.clientOrigin,
    });
  const ports: ThreadCommandPorts = {
    async submitPrompt(input) {
      await request(`/threads/${encodeURIComponent(input.threadId)}/message`, {
        content: input.content,
      });
    },
    async stopRun(threadId) {
      await request(`/threads/${encodeURIComponent(threadId)}/stop`);
    },
    async resumeRun(input) {
      await request(`/threads/${encodeURIComponent(input.threadId)}/message`, {
        content: input.content,
      });
    },
    async respondPermission(input) {
      await request(
        `/threads/${encodeURIComponent(input.threadId)}/permission-requests/${encodeURIComponent(input.requestId)}/respond`,
        { decision: input.decision },
      );
    },
  };
  return createThreadCommandController({ store: options.workspace, ports });
}
