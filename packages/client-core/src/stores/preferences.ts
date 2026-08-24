import type { DiagnosticService, StorageService, Unsubscribe } from '../platform';
import type { PortableStore } from './thread-read';
import { createStore } from './vanilla-store';

export type FontSizePreference = 'small' | 'default' | 'large';
export type ThreadViewerPreference = 'virtual' | 'frozen';

export const PREFERENCE_KEYS = {
  fontSize: 'funny_font_size',
  threadViewer: 'funny_thread_viewer',
  notificationsEnabled: 'funny_notifications_enabled',
  notificationSoundEnabled: 'funny_notifications_sound',
  hiddenPromptModels: 'funny_hidden_prompt_models',
  hiddenPromptModelsVersion: 'funny_hidden_prompt_models_version',
} as const;

export interface ClientPreferencesState {
  fontSize: FontSizePreference;
  threadViewer: ThreadViewerPreference;
  notificationsEnabled: boolean;
  notificationSoundEnabled: boolean;
  hiddenPromptModels: string[];
  setFontSize(value: FontSizePreference): void;
  setThreadViewer(value: ThreadViewerPreference): void;
  setNotificationsEnabled(value: boolean): void;
  setNotificationSoundEnabled(value: boolean): void;
  setHiddenPromptModels(value: string[]): void;
}

function safeRead(
  storage: StorageService,
  diagnostics: DiagnosticService,
  key: string,
): string | null {
  try {
    return storage.read(key);
  } catch (error) {
    diagnostics.report({ capability: 'storage', operation: `read:${key}`, error });
    return null;
  }
}

export function createClientPreferencesStore(options: {
  storage: StorageService;
  diagnostics: DiagnosticService;
  defaultHiddenPromptModels: () => string[];
  hiddenPromptModelsVersion?: string;
}): PortableStore<ClientPreferencesState> {
  const { storage, diagnostics } = options;
  const version = options.hiddenPromptModelsVersion ?? '1';
  const fontSizeRaw = safeRead(storage, diagnostics, PREFERENCE_KEYS.fontSize);
  const threadViewerRaw = safeRead(storage, diagnostics, PREFERENCE_KEYS.threadViewer);
  const storedVersion = safeRead(storage, diagnostics, PREFERENCE_KEYS.hiddenPromptModelsVersion);
  let hiddenPromptModels = options.defaultHiddenPromptModels();
  if (storedVersion === version) {
    try {
      const parsed: unknown = JSON.parse(
        safeRead(storage, diagnostics, PREFERENCE_KEYS.hiddenPromptModels) ?? '[]',
      );
      if (!Array.isArray(parsed)) throw new Error('Hidden model preferences must be an array');
      hiddenPromptModels = parsed.filter((value): value is string => typeof value === 'string');
    } catch (error) {
      diagnostics.report({ capability: 'storage', operation: 'decode:hiddenPromptModels', error });
    }
  } else {
    storage.write(PREFERENCE_KEYS.hiddenPromptModels, JSON.stringify(hiddenPromptModels));
    storage.write(PREFERENCE_KEYS.hiddenPromptModelsVersion, version);
  }

  const store = createStore<ClientPreferencesState>((set) => ({
    fontSize:
      fontSizeRaw === 'small' || fontSizeRaw === 'large' || fontSizeRaw === 'default'
        ? fontSizeRaw
        : 'default',
    threadViewer: threadViewerRaw === 'frozen' ? 'frozen' : 'virtual',
    notificationsEnabled:
      safeRead(storage, diagnostics, PREFERENCE_KEYS.notificationsEnabled) === '1',
    notificationSoundEnabled:
      safeRead(storage, diagnostics, PREFERENCE_KEYS.notificationSoundEnabled) === '1',
    hiddenPromptModels,
    setFontSize(value) {
      set({ fontSize: value });
      storage.write(PREFERENCE_KEYS.fontSize, value);
    },
    setThreadViewer(value) {
      set({ threadViewer: value });
      storage.write(PREFERENCE_KEYS.threadViewer, value);
    },
    setNotificationsEnabled(value) {
      set({ notificationsEnabled: value });
      storage.write(PREFERENCE_KEYS.notificationsEnabled, value ? '1' : '0');
    },
    setNotificationSoundEnabled(value) {
      set({ notificationSoundEnabled: value });
      storage.write(PREFERENCE_KEYS.notificationSoundEnabled, value ? '1' : '0');
    },
    setHiddenPromptModels(value) {
      set({ hiddenPromptModels: value });
      storage.write(PREFERENCE_KEYS.hiddenPromptModels, JSON.stringify(value));
    },
  }));

  const unsubscribe: Unsubscribe = storage.subscribe((change) => {
    if (change.key === PREFERENCE_KEYS.fontSize && change.value) {
      const value = change.value;
      if (value === 'small' || value === 'default' || value === 'large') {
        store.setState({ fontSize: value });
      }
    }
    if (change.key === PREFERENCE_KEYS.threadViewer) {
      store.setState({ threadViewer: change.value === 'frozen' ? 'frozen' : 'virtual' });
    }
    if (change.key === PREFERENCE_KEYS.notificationsEnabled) {
      store.setState({ notificationsEnabled: change.value === '1' });
    }
    if (change.key === PREFERENCE_KEYS.notificationSoundEnabled) {
      store.setState({ notificationSoundEnabled: change.value === '1' });
    }
    if (change.key === PREFERENCE_KEYS.hiddenPromptModels && change.value) {
      try {
        const parsed: unknown = JSON.parse(change.value);
        if (Array.isArray(parsed)) {
          store.setState({
            hiddenPromptModels: parsed.filter(
              (value): value is string => typeof value === 'string',
            ),
          });
        }
      } catch (error) {
        diagnostics.report({
          capability: 'storage',
          operation: 'decode:hiddenPromptModels',
          error,
        });
      }
    }
  });
  return Object.assign(store, { dispose: unsubscribe });
}
