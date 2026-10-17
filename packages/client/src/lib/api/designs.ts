import type { Design, DesignFidelity, DesignType } from '@funny/shared';

import { request } from './_core';

interface CreateDesignInput {
  name: string;
  type: DesignType;
  fidelity?: DesignFidelity | null;
  speakerNotes?: boolean;
}

export const designsApi = {
  listDesigns: (projectId: string) => request<Design[]>(`/projects/${projectId}/designs`),
  createDesign: (projectId: string, input: CreateDesignInput) =>
    request<Design>(`/projects/${projectId}/designs`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  getDesign: (id: string) => request<Design>(`/designs/${id}`),
  deleteDesign: (id: string) => request<{ ok: boolean }>(`/designs/${id}`, { method: 'DELETE' }),
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
