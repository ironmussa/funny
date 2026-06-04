import type { FunnyHostApi } from '@funny/host';
import { useTheme } from 'next-themes';

import { PROSE_FONT_SIZE_PX, useSettingsStore } from '@/stores/settings-store';

/**
 * The concrete `@funny/host` hook implementations, backed by the host's real
 * theme + settings stores. Installed on `globalThis.__FUNNY_HOST__` at boot
 * (see `host-runtime.ts`); the `/vendor/funny-host.mjs` import-map shim re-reads
 * this object so plugins call these same hooks against the host's React tree.
 *
 * These are React hooks — plugins call them during render, which is valid
 * because the plugin shares the host's single React instance.
 */
export const hostApi: FunnyHostApi = {
  useFunnyTheme(): 'light' | 'dark' {
    const { resolvedTheme } = useTheme();
    // funny ships a few named themes; collapse them to light/dark for plugins.
    return resolvedTheme === 'light' || resolvedTheme === 'monochrome' ? 'light' : 'dark';
  },
  useFunnyFontSize(): number {
    return PROSE_FONT_SIZE_PX[useSettingsStore((s) => s.fontSize)];
  },
};
