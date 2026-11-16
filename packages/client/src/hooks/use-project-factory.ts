/**
 * The caller's issue factory for a project (change issue-factory): loads the
 * settings and exposes an optimistic save. A lightweight fetch hook — the
 * factory panel is the only reader, so it does not live in the data layer.
 */
import { useCallback, useEffect, useState } from 'react';

import { factoryApi, type FactorySettings, type SaveFactorySettingsInput } from '@/lib/api/factory';

export interface UseProjectFactory {
  settings: FactorySettings | null;
  loading: boolean;
  save: (input: SaveFactorySettingsInput) => Promise<void>;
}

export function useProjectFactory(projectId: string | null | undefined): UseProjectFactory {
  const [settings, setSettings] = useState<FactorySettings | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!projectId) {
      setSettings(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void factoryApi.getSettings(projectId).match(
      (res) => {
        if (!cancelled) {
          setSettings(res.settings);
          setLoading(false);
        }
      },
      () => {
        if (!cancelled) setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const save = useCallback(
    async (input: SaveFactorySettingsInput) => {
      if (!projectId) return;
      // Optimistic: reflect the change at once; the server answer confirms it.
      setSettings((prev) =>
        prev ? { ...prev, ...input, label: input.label ?? prev.label } : prev,
      );
      await factoryApi.saveSettings(projectId, input).match(
        (res) => setSettings(res.settings),
        () => {
          // On failure, re-read the server's truth.
          void factoryApi.getSettings(projectId).match(
            (res) => setSettings(res.settings),
            () => undefined,
          );
        },
      );
    },
    [projectId],
  );

  return { settings, loading, save };
}
