import type { DiagnosticService, EffectService, SemanticEffect } from '@funny/client-core';

export interface BrowserEffectRuntime {
  toast(
    level: Extract<SemanticEffect, { type: 'toast' }>['level'],
    message: string,
    description?: string,
  ): void;
  notify(title: string, options?: NotificationOptions): void;
  notificationPermission(): NotificationPermission | 'unsupported';
  dispatch(name: string, detail: unknown): void;
}

export function createBrowserEffectService(
  runtime: BrowserEffectRuntime,
  diagnostics: DiagnosticService,
): EffectService {
  return {
    emit(effect) {
      if (effect.type === 'toast') {
        if (effect.description) runtime.toast(effect.level, effect.message, effect.description);
        else runtime.toast(effect.level, effect.message);
        return;
      }
      if (effect.type === 'application-event') {
        runtime.dispatch(effect.name, effect.detail);
        return;
      }
      if (runtime.notificationPermission() !== 'granted') {
        diagnostics.report({
          capability: 'effects',
          operation: 'notification',
          error: new Error('System notifications are unavailable or not permitted'),
          optional: true,
        });
        return;
      }
      runtime.notify(effect.title, { body: effect.body, tag: effect.tag });
    },
  };
}

export function browserEffectRuntime(
  win: Window,
  showToast: BrowserEffectRuntime['toast'],
): BrowserEffectRuntime {
  return {
    toast: showToast,
    notificationPermission: () =>
      typeof Notification === 'function' ? Notification.permission : 'unsupported',
    notify: (title, options) => {
      new Notification(title, options);
    },
    dispatch: (name, detail) => win.dispatchEvent(new CustomEvent(name, { detail })),
  };
}
