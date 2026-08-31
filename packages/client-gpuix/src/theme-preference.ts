import {
  createStore,
  type StoreApi,
  type StorageService,
  type Unsubscribe,
} from '@funny/client-core';
import { isVisualThemeName, type VisualThemeName } from '@funny/ui-contracts/tokens';

export const NATIVE_THEME_STORAGE_KEY = 'theme';
export const DEFAULT_NATIVE_THEME: VisualThemeName = 'one-dark';

export interface NativeThemePreferenceState {
  name: VisualThemeName;
}

export function resolveNativeTheme(value: string | null): VisualThemeName {
  return isVisualThemeName(value) && value !== 'reference-dark' ? value : DEFAULT_NATIVE_THEME;
}

export class NativeThemePreferenceService {
  readonly state: StoreApi<NativeThemePreferenceState>;
  private readonly unsubscribe: Unsubscribe;

  constructor(private readonly storage: StorageService) {
    this.state = createStore<NativeThemePreferenceState>(() => ({
      name: resolveNativeTheme(storage.read(NATIVE_THEME_STORAGE_KEY)),
    }));
    this.unsubscribe = storage.subscribe((change) => {
      if (change.key !== NATIVE_THEME_STORAGE_KEY) return;
      this.state.setState({ name: resolveNativeTheme(change.value) });
    });
  }

  select(name: VisualThemeName): void {
    if (name === 'reference-dark') return;
    this.storage.write(NATIVE_THEME_STORAGE_KEY, name);
  }

  dispose(): void {
    this.unsubscribe();
  }
}
