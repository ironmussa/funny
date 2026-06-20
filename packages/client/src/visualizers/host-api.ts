import type { FunnyPluginSdkApi } from '@funny/plugin-sdk';
import { useTheme } from 'next-themes';

import { PROSE_FONT_SIZE_PX, useSettingsStore } from '@/stores/settings-store';

/**
 * The concrete `@funny/plugin-sdk` hook implementations, backed by the host's real
 * theme + settings stores. Installed on `globalThis.__FUNNY_PLUGIN_SDK__` at boot
 * (see `host-runtime.ts`); the `/vendor/funny-plugin-sdk.mjs` import-map shim re-reads
 * this object so plugins call these same hooks against the host's React tree.
 *
 * These are React hooks — plugins call them during render, which is valid
 * because the plugin shares the host's single React instance.
 */
export const pluginSdkApi: FunnyPluginSdkApi = {
  useFunnyTheme(): 'light' | 'dark' {
    const { resolvedTheme } = useTheme();
    // funny ships a few named themes; collapse them to light/dark for plugins.
    return resolvedTheme === 'light' || resolvedTheme === 'monochrome' ? 'light' : 'dark';
  },
  useFunnyFontSize(): number {
    return PROSE_FONT_SIZE_PX[useSettingsStore((s) => s.fontSize)];
  },
};
