import { DockLayout } from '@funny/gpuix-ui/dock-layout';
import { PointerCaptureScope } from '@funny/gpuix-ui/pointer-capture';
import { gpuixTheme, GpuixUiProvider } from '@funny/gpuix-ui/theme';
import { useWindowSize } from '@gpuix/react';
import { type ReactElement, useCallback, useMemo, useState } from 'react';

import { NativeFileTreeDock } from './app/file-tree-dock';
import { NativeButton, useNativeColors, useStore } from './app/hooks';
import { LoginView } from './app/login-view';
import { Sidebar } from './app/sidebar';
import { ThreadView } from './app/thread-view';
import type { NativeApplicationServices } from './application';
import { diagnosticSurfacePosition } from './diagnostic-mode';
import { NATIVE_HOST_FOCUS_EVIDENCE } from './platform/lifecycle';
import { resolveFileTreeVisibility, resolveSidebarVisibility } from './responsive-layout';

function AuthenticatedShell({
  application,
  diagnostics,
  onHistoryList,
  onResetFrameStats,
}: {
  application: NativeApplicationServices;
  diagnostics: boolean;
  onHistoryList?: (id: number | null) => void;
  onResetFrameStats?: () => void;
}) {
  const colors = useNativeColors();
  const { width, height } = useWindowSize({ intervalMs: 250 });
  const [sidebarOverride, setSidebarOverride] = useState<boolean | null>(null);
  const [filesOverride, setFilesOverride] = useState<boolean | null>(null);
  const sidebarVisible = resolveSidebarVisibility(width, sidebarOverride);
  const filesVisible = resolveFileTreeVisibility(width, filesOverride);
  const toggleSidebar = useCallback(
    () => setSidebarOverride((current) => !resolveSidebarVisibility(width, current)),
    [width],
  );
  const toggleFiles = useCallback(
    () => setFilesOverride((current) => !resolveFileTreeVisibility(width, current)),
    [width],
  );
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        width: '100%',
        height: '100%',
        minHeight: 0,
        position: 'relative',
      }}
    >
      <DockLayout.Root
        key={`${sidebarVisible ? 'expanded' : 'compact'}-${filesVisible ? 'files' : 'no-files'}`}
        defaultValue={application.dockLayoutPreference.current()}
        onValueCommit={(layout) => application.dockLayoutPreference.save(layout)}
      >
        {sidebarVisible ? (
          <DockLayout.Panel id="navigation" defaultSize={300} minSize={260} maxSize={600}>
            <DockLayout.Handle testId="navigation-dock-handle">
              <text style={{ color: colors.muted, fontSize: 10 }}>Navigation</text>
            </DockLayout.Handle>
            <Sidebar application={application} />
          </DockLayout.Panel>
        ) : null}
        {filesVisible ? (
          <DockLayout.Panel id="files" defaultSize={300} minSize={240} maxSize={600}>
            <DockLayout.Handle testId="files-dock-handle">
              <text style={{ color: colors.muted, fontSize: 10 }}>Files</text>
            </DockLayout.Handle>
            <NativeFileTreeDock application={application} viewportHeight={height} />
          </DockLayout.Panel>
        ) : null}
        <DockLayout.Panel id="conversation" minSize={400}>
          <DockLayout.Handle testId="conversation-dock-handle">
            <text style={{ color: colors.muted, fontSize: 10 }}>Conversation</text>
          </DockLayout.Handle>
          <ThreadView
            application={application}
            diagnostics={diagnostics}
            sidebarVisible={sidebarVisible}
            filesVisible={filesVisible}
            onToggleSidebar={toggleSidebar}
            onToggleFiles={toggleFiles}
            onHistoryList={onHistoryList}
            onResetFrameStats={onResetFrameStats}
          />
        </DockLayout.Panel>
      </DockLayout.Root>
      {diagnostics ? (
        <div
          testId="diagnostic-surface"
          style={{
            ...diagnosticSurfacePosition,
            display: 'flex',
            flexDirection: 'row',
            gap: 5,
            padding: 5,
            backgroundColor: colors.overlay,
            borderWidth: 1,
            borderColor: colors.warning,
            borderRadius: 6,
          }}
        >
          <text style={{ color: colors.warning, fontSize: 11 }}>Diagnostics</text>
          <text style={{ color: colors.muted, fontSize: 11 }}>
            Host focus: {NATIVE_HOST_FOCUS_EVIDENCE.reason}
          </text>
          <NativeButton
            variant="ghost"
            size="small"
            onPress={() => {
              void application.logout();
            }}
          >
            <text>Log out</text>
          </NativeButton>
        </div>
      ) : null}
    </div>
  );
}

export function GpuixClientApp({
  application,
  unsupportedReason,
  diagnostics = false,
  onHistoryList,
  onResetFrameStats,
}: {
  application: NativeApplicationServices;
  unsupportedReason?: string;
  diagnostics?: boolean;
  onHistoryList?: (id: number | null) => void;
  onResetFrameStats?: () => void;
}): ReactElement {
  const auth = useStore(application.authState);
  const status = useStore(application.statusState);
  const themePreference = useStore(application.themePreference.state);
  const theme = useMemo(() => gpuixTheme(themePreference.name), [themePreference.name]);
  const colors = theme.colors;
  return (
    <GpuixUiProvider theme={theme}>
      <div
        style={{
          display: 'flex',
          width: '100%',
          height: '100%',
          backgroundColor: colors.background,
          color: colors.text,
        }}
      >
        <PointerCaptureScope>
          {unsupportedReason ? (
            <div style={{ padding: 24, gap: 10 }}>
              <text style={{ color: colors.danger, fontSize: 20 }}>
                GPUIX is unsupported on this host
              </text>
              <text>{unsupportedReason}</text>
              <text style={{ color: colors.muted }}>
                Run `bun run dev:client` to use the web renderer.
              </text>
            </div>
          ) : null}
          {!unsupportedReason &&
          (auth.phase === 'bootstrapping' || status.phase === 'bootstrapping') ? (
            <div style={{ padding: 24 }}>
              <text>Restoring session…</text>
            </div>
          ) : null}
          {!unsupportedReason && status.phase === 'error' ? (
            <div style={{ padding: 24, gap: 10 }}>
              <text style={{ color: colors.danger }}>
                Recoverable startup error: {status.error}
              </text>
              <NativeButton
                onPress={() => {
                  void application.retry();
                }}
              >
                <text>Retry startup</text>
              </NativeButton>
            </div>
          ) : null}
          {!unsupportedReason &&
          status.phase !== 'error' &&
          (auth.phase === 'anonymous' || auth.phase === 'rejected') ? (
            <div>
              {auth.rejection ? (
                <text style={{ color: colors.danger }}>{auth.rejection}</text>
              ) : null}
              <LoginView application={application} />
            </div>
          ) : null}
          {!unsupportedReason && status.phase === 'ready' && auth.phase === 'authenticated' ? (
            <AuthenticatedShell
              application={application}
              diagnostics={diagnostics}
              onHistoryList={onHistoryList}
              onResetFrameStats={onResetFrameStats}
            />
          ) : null}
        </PointerCaptureScope>
      </div>
    </GpuixUiProvider>
  );
}
