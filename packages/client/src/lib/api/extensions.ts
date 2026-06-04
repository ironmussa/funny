import { request } from './_core';

export interface InstalledExtension {
  /** On-disk directory name — the handle used to remove the extension. */
  name: string;
  /** Package id (npm name). */
  id: string;
  version: string;
  description?: string;
  entryUrl: string;
}

export const extensionsApi = {
  /** List installed client extensions (visualizer plugins) for management. */
  listInstalledExtensions: () => request<InstalledExtension[]>('/extensions/installed'),

  /** Install an extension by copying a local pre-built package directory on the
   *  server host into `~/.funny/extensions`. */
  installExtension: (path: string) =>
    request<{ extension: InstalledExtension }>('/extensions/install', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),

  /** Remove an installed extension by its on-disk directory name. */
  removeExtension: (name: string) =>
    request<{ ok: boolean }>(`/extensions/${encodeURIComponent(name)}`, { method: 'DELETE' }),
};
