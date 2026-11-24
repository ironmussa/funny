import type { DiagnosticService, EffectService, SemanticEffect } from '@funny/client-core';

/** An effect the browser forwards to the page as a DOM `CustomEvent`. */
type ApplicationEventEffect = Extract<SemanticEffect, { type: 'application-event' }>;

export interface BrowserEffectRuntime {
  toast(
    level: Extract<SemanticEffect, { type: 'toast' }>['level'],
    message: string,
    description?: string,
  ): void;
  notify(title: string, options?: NotificationOptions): void;
  notificationPermission(): NotificationPermission | 'unsupported';
  dispatch(event: ApplicationEventEffect): void;
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
        runtime.dispatch(effect);
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

function isFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === 'function';
}

export function browserEffectRuntime(
  win: Window,
  showToast: BrowserEffectRuntime['toast'],
): BrowserEffectRuntime {
  return {
    toast: showToast,
    notificationPermission: () =>
      isFunction(globalThis.Notification) ? Notification.permission : 'unsupported',
    notify: (title, options) => {
      new Notification(title, options);
    },
    dispatch: ({ name, detail }) => win.dispatchEvent(new CustomEvent(name, { detail })),
  };
}
