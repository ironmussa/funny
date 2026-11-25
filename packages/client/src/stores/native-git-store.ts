import { create } from 'zustand';

import { createClientLogger } from '@/lib/client-logger';

const log = createClientLogger('native-git-store');

interface NativeGitState {
  buildOutput: string;
  buildStatus: 'idle' | 'building' | 'completed' | 'failed';
  buildExitCode?: number;
  appendBuildOutput: (text: string) => void;
  setBuildStatus: (status: string, exitCode?: number) => void;
  clearBuild: () => void;
}

export const useNativeGitStore = create<NativeGitState>((set) => ({
  buildOutput: '',
  buildStatus: 'idle',
  buildExitCode: undefined,

  appendBuildOutput: (text: string) => {
    set((s) => ({ buildOutput: s.buildOutput + text }));
  },

  setBuildStatus: (status: string, exitCode?: number) => {
    log.info('native-git build status', { status, exitCode: String(exitCode ?? '') });
    set({
      // SAFETY: the only caller forwards `native-git:build_status` events, which the runner
      // (runtime app/system-routes.ts) emits only with 'building', 'completed' or 'failed'.
      buildStatus: status as NativeGitState['buildStatus'],
      buildExitCode: exitCode,
    });
  },

  clearBuild: () => {
    set({ buildOutput: '', buildStatus: 'idle', buildExitCode: undefined });
  },
}));
