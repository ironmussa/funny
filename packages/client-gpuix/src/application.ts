import {
  createAuthSessionStore,
  createStore,
  createThreadNavigationStore,
  createThreadWorkspaceStore,
} from '@funny/client-core';

import { NativeDockLayoutPreference } from './dock-layout-preference';
import { NativeFileTreeService } from './file-tree-state';
import { createNativeGitStatusStore } from './git-status-state';
import type { NativeClientComposition } from './platform/composition';
import { NativeAuthService } from './services/auth';
import { NativeRealtimeService } from './services/realtime';
import type { NativeSocket } from './services/realtime';
import { createNativeRealtimeActions } from './services/realtime-actions';
import { createNativeThreadCommands } from './services/thread-commands';
import { NativeThreadDataService } from './services/thread-data';
import { NativeThemePreferenceService } from './theme-preference';

export function createNativeApplicationServices(
  composition: NativeClientComposition,
  options: {
    socketFactory?: (input: {
      origin: string;
      cookie: string;
      clientOrigin: string;
    }) => NativeSocket;
  } = {},
) {
  const statusState = createStore<{
    phase: 'bootstrapping' | 'ready' | 'error';
    error: string | null;
  }>(() => ({ phase: 'bootstrapping', error: null }));
  const authState = createAuthSessionStore();
  const navigationState = createThreadNavigationStore();
  const workspaceState = createThreadWorkspaceStore();
  const gitStatusState = createNativeGitStatusStore();
  const dockLayoutPreference = new NativeDockLayoutPreference(composition.platform.storage);
  const fileTree = new NativeFileTreeService({
    platform: composition.platform,
    clientOrigin: composition.clientOrigin,
  });
  const themePreference = new NativeThemePreferenceService(composition.platform.storage);
  const auth = new NativeAuthService({
    platform: composition.platform,
    cookies: composition.cookies,
    state: authState,
    clientOrigin: composition.clientOrigin,
  });
  const data = new NativeThreadDataService({
    composition,
    auth,
    authState,
    navigation: navigationState,
    workspace: workspaceState,
    gitStatus: gitStatusState,
  });
  const commands = createNativeThreadCommands({ composition, workspace: workspaceState });
  const realtime = new NativeRealtimeService({
    platform: composition.platform,
    cookies: composition.cookies,
    actions: createNativeRealtimeActions({
      workspace: workspaceState,
      navigation: navigationState,
      gitStatus: gitStatusState,
      diagnostics: composition.platform.diagnostics,
    }),
    effects: {
      emit(effect) {
        if (effect.type !== 'agent-result') return;
        composition.platform.effects.emit({
          type: 'toast',
          level: effect.status === 'completed' ? 'success' : 'error',
          message: effect.status === 'completed' ? 'Agent completed' : 'Agent failed',
          description: effect.errorReason,
        });
      },
    },
    clientOrigin: composition.clientOrigin,
    socketFactory: options.socketFactory,
    refreshForFocus: () => {
      void data.resyncSelected();
    },
    refreshForReconnect: () => {
      void data.resyncSelected();
    },
    onSessionRejected() {
      auth.rejectSession();
      navigationState.getState().removeProtectedResources();
      workspaceState.getState().clearProtectedResources();
      gitStatusState.getState().clear();
      fileTree.clear();
    },
  });

  return {
    statusState,
    authState,
    navigationState,
    workspaceState,
    gitStatusState,
    dockLayoutPreference,
    fileTree,
    themePreference,
    auth,
    realtime,
    data,
    commands,
    async start() {
      statusState.setState({ phase: 'bootstrapping', error: null });
      try {
        const session = await auth.restore();
        if (session) {
          await data.loadNavigation();
          realtime.connect();
        }
        statusState.setState({ phase: 'ready', error: null });
        return session;
      } catch (error) {
        statusState.setState({
          phase: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
    async signIn(username: string, password: string) {
      statusState.setState({ phase: 'bootstrapping', error: null });
      try {
        const session = await auth.signIn(username, password);
        await data.loadNavigation();
        realtime.connect();
        statusState.setState({ phase: 'ready', error: null });
        return session;
      } catch (error) {
        statusState.setState({
          phase: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    async retry() {
      statusState.setState({ phase: 'bootstrapping', error: null });
      try {
        if (authState.getState().phase === 'authenticated') {
          await data.loadNavigation();
          realtime.connect();
          statusState.setState({ phase: 'ready', error: null });
          return true;
        }
        const session = await auth.restore();
        if (session) {
          await data.loadNavigation();
          realtime.connect();
        }
        statusState.setState({ phase: 'ready', error: null });
        return session !== null;
      } catch (error) {
        statusState.setState({
          phase: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    },
    async logout() {
      realtime.disconnect();
      try {
        await auth.logout();
      } finally {
        navigationState.getState().removeProtectedResources();
        workspaceState.getState().clearProtectedResources();
        gitStatusState.getState().clear();
        fileTree.clear();
        statusState.setState({ phase: 'ready', error: null });
      }
    },
    dispose() {
      realtime.disconnect();
      fileTree.clear();
      themePreference.dispose();
      composition.transport.dispose();
    },
  };
}

export type NativeApplicationServices = ReturnType<typeof createNativeApplicationServices>;
