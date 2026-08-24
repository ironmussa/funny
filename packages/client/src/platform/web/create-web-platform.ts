import type { ClientDiagnostic, ClientPlatform, DiagnosticService } from '@funny/client-core';

import {
  browserEffectRuntime,
  createBrowserEffectService,
  type BrowserEffectRuntime,
} from './browser-effects';
import {
  browserLifecycleRuntime,
  browserNavigationRuntime,
  createBrowserLifecycleService,
  createBrowserNavigationService,
} from './browser-navigation';
import { browserStorageRuntime, createBrowserStorageService } from './browser-storage';
import { createBrowserTransportService, resolveWebEnvironment } from './browser-transport';

export interface CreateWebPlatformOptions {
  window: Window;
  document: Document;
  fetch: typeof fetch;
  serverPort?: string;
  allowedContainerOrigins?: string;
  showToast: BrowserEffectRuntime['toast'];
  reportDiagnostic?: (diagnostic: ClientDiagnostic) => void;
}

export function createWebPlatform(options: CreateWebPlatformOptions): ClientPlatform {
  const diagnostics: DiagnosticService = {
    report:
      options.reportDiagnostic ?? ((diagnostic) => console.warn('[client-platform]', diagnostic)),
  };
  const environment = resolveWebEnvironment({
    isTauri: '__TAURI_INTERNALS__' in options.window,
    pageOrigin: options.window.location.origin,
    serverPort: options.serverPort,
    allowedContainerOrigins: options.allowedContainerOrigins,
  });

  return {
    diagnostics,
    storage: createBrowserStorageService(browserStorageRuntime(options.window), diagnostics),
    navigation: createBrowserNavigationService(browserNavigationRuntime(options.window)),
    lifecycle: createBrowserLifecycleService(
      browserLifecycleRuntime(options.window, options.document),
    ),
    transport: createBrowserTransportService(environment, options.fetch, diagnostics),
    effects: createBrowserEffectService(
      browserEffectRuntime(options.window, options.showToast),
      diagnostics,
    ),
  };
}
