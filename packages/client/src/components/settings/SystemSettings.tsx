import { RefreshCw, Hammer, CircleCheck, CircleX, Circle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { createAnsiConverter } from '@/lib/ansi-to-html';
import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { cn } from '@/lib/utils';
import { useNativeGitStore } from '@/stores/native-git-store';

const log = createClientLogger('system-settings');

interface NativeGitInfo {
  loaded: boolean;
  disabled: boolean;
  rustAvailable: boolean;
  rustVersion: string | null;
  platform: string;
  canBuild: boolean;
}

const ansiConverter = createAnsiConverter({
  fg: '#abb2bf',
  bg: 'transparent',
  newline: true,
});

export function SystemSettings() {
  const [nativeGit, setNativeGit] = useState<NativeGitInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const { buildOutput, buildStatus, clearBuild } = useNativeGitStore();
  const scrollRef = useRef<HTMLDivElement>(null);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    const result = await api.setupStatus();
    if (result.isOk() && result.value.nativeGit) {
      setNativeGit(result.value.nativeGit);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Auto-scroll build output
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [buildOutput]);

  const handleBuild = useCallback(async () => {
    clearBuild();
    const result = await api.buildNativeGit();
    if (result.isErr()) {
      log.error('Failed to start native git build', { error: result.error.message });
      toast.error('Failed to start build: ' + result.error.message);
    }
  }, [clearBuild]);

  if (loading && !nativeGit) {
    return (
      <div className="p-1">
        <h3 className="settings-section-header">System</h3>
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  const isActive = nativeGit?.loaded && !nativeGit?.disabled;
  const isBuilding = buildStatus === 'building';
  const buildSucceeded = buildStatus === 'completed';
  const buildFailed = buildStatus === 'failed';

  return (
    <div className="space-y-6">
      <div>
        <h3 className="settings-section-header">System</h3>
        <p className="px-1 pb-3 text-xs text-muted-foreground">
          System-level configuration and native module management.
        </p>
      </div>

      {/* Native Git Section */}
      <div className="settings-card">
        <div className="px-4 py-3.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <p className="settings-row-title">Native Git (gitoxide)</p>
              {nativeGit && (
                <Badge
                  variant="outline"
                  className={cn(
                    'h-5 px-2 text-[10px]',
                    isActive
                      ? 'border-green-500/30 text-green-500'
                      : nativeGit.disabled
                        ? 'border-yellow-500/30 text-yellow-500'
                        : 'border-muted-foreground/30 text-muted-foreground',
                  )}
                  data-testid="system-native-git-status"
                >
                  {isActive ? 'Active' : nativeGit.disabled ? 'Disabled' : 'Inactive'}
                </Badge>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={fetchStatus}
              disabled={loading}
              data-testid="system-native-git-refresh"
            >
              <RefreshCw className={cn('icon-sm', loading && 'animate-spin')} />
            </Button>
          </div>

          <p className="settings-row-desc mt-1">
            Rust-based git implementation for 5-10x faster status, diff, log, and branch operations.
            When inactive, funny falls back to the standard git CLI (fully functional).
          </p>

          {nativeGit && (
            <div className="mt-3 space-y-2 text-xs text-muted-foreground">
              <div className="flex items-center gap-2">
                <span className="w-16 font-medium">Platform</span>
                <code className="rounded bg-muted px-1.5 py-0.5">{nativeGit.platform}</code>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-16 font-medium">Rust</span>
                {nativeGit.rustAvailable ? (
                  <span className="flex items-center gap-1 text-green-500">
                    <CircleCheck className="size-3" />
                    {nativeGit.rustVersion}
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-muted-foreground">
                    <CircleX className="size-3" />
                    Not installed
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Action area */}
          {nativeGit && !isActive && !isBuilding && !buildSucceeded && (
            <div className="mt-4">
              {nativeGit.disabled ? (
                <p className="text-xs text-yellow-500">
                  Native git is disabled via{' '}
                  <code className="rounded bg-muted px-1 py-0.5">FUNNY_DISABLE_NATIVE_GIT=1</code>.
                  Remove this environment variable and restart funny to enable it.
                </p>
              ) : nativeGit.canBuild ? (
                <Button
                  size="sm"
                  onClick={handleBuild}
                  disabled={isBuilding}
                  data-testid="system-native-git-build"
                >
                  <Hammer className="icon-sm mr-1.5" />
                  Build Native Module
                </Button>
              ) : !nativeGit.rustAvailable ? (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    Install the Rust toolchain to build the native module:
                  </p>
                  <code className="block rounded bg-muted px-3 py-2 text-xs">
                    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
                  </code>
                  <p className="text-xs text-muted-foreground">
                    After installing Rust, click refresh to detect it.
                  </p>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  The native-git source package was not found. This is only available when running
                  from a development checkout.
                </p>
              )}
            </div>
          )}

          {/* Build in progress */}
          {isBuilding && (
            <div className="mt-4 space-y-2">
              <div className="flex items-center gap-2">
                <Circle className="size-3 animate-pulse fill-yellow-500 text-yellow-500" />
                <span className="text-xs font-medium">Building…</span>
              </div>
            </div>
          )}

          {/* Build result */}
          {buildSucceeded && (
            <div className="mt-4 space-y-2">
              <div className="flex items-center gap-2 text-green-500">
                <CircleCheck className="size-3.5" />
                <span className="text-xs font-medium">Build successful!</span>
              </div>
              <p className="text-xs text-muted-foreground">Restart funny to activate native git.</p>
            </div>
          )}

          {buildFailed && (
            <div className="mt-4 space-y-2">
              <div className="flex items-center gap-2 text-destructive">
                <CircleX className="size-3.5" />
                <span className="text-xs font-medium">Build failed</span>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={handleBuild}
                data-testid="system-native-git-retry"
              >
                Retry Build
              </Button>
            </div>
          )}

          {/* Build output log */}
          {buildOutput && (
            <div className="mt-3">
              <ScrollArea className="h-64 rounded border border-border bg-[#1e1e2e]">
                <div
                  ref={scrollRef}
                  className="h-full overflow-y-auto p-3 font-mono text-xs leading-relaxed"
                  data-testid="system-native-git-build-output"
                  dangerouslySetInnerHTML={{
                    __html: ansiConverter.toHtml(buildOutput),
                  }}
                />
              </ScrollArea>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
