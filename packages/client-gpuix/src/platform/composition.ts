import { join } from 'node:path';

import { validateClientPlatform, type ClientPlatform } from '@funny/client-core';

import { resolveNativeAppDataDirectory } from './app-data';
import { NativeDiagnosticService, type SafeClientDiagnostic } from './diagnostics';
import { NativeEffectService, type NativeEffectPresenters } from './effects';
import { NativeLifecycleService } from './lifecycle';
import { NativeNavigationService } from './navigation';
import { FileNativeSessionStore, MemoryNativeSessionStore } from './session-store';
import { NativeKeyValueStorage } from './storage';
import {
  NativeCookieJar,
  NativeTransportService,
  type NativeFetch,
  type NativeFetchResponse,
} from './transport';

export interface NativeClientComposition {
  platform: ClientPlatform;
  lifecycle: NativeLifecycleService;
  navigation: NativeNavigationService;
  cookies: NativeCookieJar;
  transport: NativeTransportService;
  dataDirectory: string;
  serverOrigin: string;
  clientOrigin: string;
}

export interface NativeCompositionOptions {
  serverOrigin?: string;
  clientOrigin?: string;
  localServerPort?: number;
  remoteOriginAllowlist?: readonly string[];
  dataDirectory?: string;
  persistentSession?: boolean;
  fetch?: NativeFetch;
  effects?: NativeEffectPresenters;
  diagnosticSink?: (diagnostic: SafeClientDiagnostic) => void;
}

const nativeFetch: NativeFetch = async (url, init): Promise<NativeFetchResponse> => {
  return fetch(url, init);
};

export function createNativeClientComposition(
  options: NativeCompositionOptions = {},
): NativeClientComposition {
  const diagnosticSink =
    options.diagnosticSink ??
    ((diagnostic: SafeClientDiagnostic) => {
      process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
    });
  const diagnostics = new NativeDiagnosticService(diagnosticSink);
  const dataDirectory =
    options.dataDirectory ??
    resolveNativeAppDataDirectory({ platform: process.platform, environment: process.env });
  const sessionStore =
    options.persistentSession === false
      ? new MemoryNativeSessionStore()
      : new FileNativeSessionStore(join(dataDirectory, 'session.json'), diagnostics);
  const cookies = new NativeCookieJar(sessionStore, diagnostics);
  const navigation = new NativeNavigationService();
  const lifecycle = new NativeLifecycleService();
  const serverOrigin =
    options.serverOrigin ?? `http://localhost:${options.localServerPort ?? 5002}`;
  const clientOrigin = options.clientOrigin ?? 'http://localhost:5173';
  const transport = new NativeTransportService({
    serverOrigin,
    localServerPort: options.localServerPort ?? 5002,
    remoteOriginAllowlist: options.remoteOriginAllowlist ?? [],
    fetch: options.fetch ?? nativeFetch,
    cookies,
  });
  const platform: ClientPlatform = {
    storage: new NativeKeyValueStorage(join(dataDirectory, 'preferences.json'), diagnostics),
    navigation,
    transport,
    lifecycle,
    effects: new NativeEffectService(options.effects ?? {}, diagnostics),
    diagnostics,
  };
  validateClientPlatform(platform);
  return {
    platform,
    lifecycle,
    navigation,
    cookies,
    transport,
    dataDirectory,
    serverOrigin,
    clientOrigin,
  };
}
