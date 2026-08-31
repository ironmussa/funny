import type { DiagnosticService, EffectService, SemanticEffect } from '@funny/client-core';

export interface NativeEffectPresenters {
  toast?(effect: Extract<SemanticEffect, { type: 'toast' }>): void;
  applicationEvent?(effect: Extract<SemanticEffect, { type: 'application-event' }>): void;
  notification?(effect: Extract<SemanticEffect, { type: 'notification' }>): void;
}

export class NativeEffectService implements EffectService {
  constructor(
    private readonly presenters: NativeEffectPresenters,
    private readonly diagnostics: DiagnosticService,
  ) {}

  emit(effect: SemanticEffect): void {
    if (effect.type === 'toast' && this.presenters.toast) return this.presenters.toast(effect);
    if (effect.type === 'notification' && this.presenters.notification) {
      return this.presenters.notification(effect);
    }
    if (effect.type === 'application-event' && this.presenters.applicationEvent) {
      return this.presenters.applicationEvent(effect);
    }
    this.diagnostics.report({
      capability: 'effects',
      operation: `unsupported.${effect.type}`,
      error: new Error(`Native effect ${effect.type} is unsupported`),
      optional: true,
    });
  }
}
