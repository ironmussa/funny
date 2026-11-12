import type { CreateDesignRequest } from '@funny/shared/contracts/designs';

import { request } from './_core';
import { trpc, trpcCall } from './_trpc';

const procedures = trpc.designs;

export const designsApi = {
  listDesigns: (projectId: string) => trpcCall(() => procedures.list.query({ projectId })),
  createDesign: (projectId: string, input: CreateDesignRequest) =>
    trpcCall(() => procedures.create.mutate({ projectId, ...input })),
  getDesign: (id: string) => trpcCall(() => procedures.get.query({ id })),
  deleteDesign: (id: string) => trpcCall(() => procedures.remove.mutate({ id })),
  // The design folder on disk is the runner's: these stay REST, proxied to it.
  createDesignDirectory: (projectId: string, designId: string) =>
    request<{ ok: boolean; path: string }>(`/projects/${projectId}/designs/directory`, {
      method: 'POST',
      body: JSON.stringify({ designId }),
    }),
  deleteDesignDirectory: (projectId: string, designId: string) =>
    request<{ ok: boolean }>(`/projects/${projectId}/designs/${designId}/directory`, {
      method: 'DELETE',
    }),
};
