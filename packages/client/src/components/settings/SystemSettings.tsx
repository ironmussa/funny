import { RefreshCw, Hammer, CircleCheck, CircleX, Circle, Copy } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { createAnsiConverter } from '@/lib/ansi-to-html';
import { api } from '@/lib/api';
import { BUILD_INFO } from '@/lib/build-info';
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
        <p className="text-muted-foreground text-sm">Loading…</p>
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
        <p className="text-muted-foreground px-1 pb-3 text-sm">
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
            <div className="text-muted-foreground mt-3 space-y-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="w-16 font-medium">Platform</span>
                <code className="bg-muted rounded px-1.5 py-0.5">{nativeGit.platform}</code>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-16 font-medium">Rust</span>
                {nativeGit.rustAvailable ? (
                  <span className="flex items-center gap-1 text-green-500">
                    <CircleCheck className="size-3" />
                    {nativeGit.rustVersion}
                  </span>
                ) : (
                  <span className="text-muted-foreground flex items-center gap-1">
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
                  <code className="bg-muted rounded px-1 py-0.5">FUNNY_DISABLE_NATIVE_GIT=1</code>.
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
                  <p className="text-muted-foreground text-xs">
                    Install the Rust toolchain to build the native module:
                  </p>
                  <code className="bg-muted block rounded px-3 py-2 text-xs">
                    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
                  </code>
                  <p className="text-muted-foreground text-xs">
                    After installing Rust, click refresh to detect it.
                  </p>
                </div>
              ) : (
                <p className="text-muted-foreground text-xs">
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
              <p className="text-muted-foreground text-xs">Restart funny to activate native git.</p>
            </div>
          )}

          {buildFailed && (
            <div className="mt-4 space-y-2">
              <div className="text-destructive flex items-center gap-2">
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
              <ScrollArea className="border-border h-64 rounded border bg-[#1e1e2e]">
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

      {/* Build identity — compare this between two installs to tell who has the newer build */}
      <BuildIdentityCard />
    </div>
  );
}

/**
 * Shows the git-derived build identity injected at build time (`__BUILD_INFO__`).
 * The "build" number is the git commit count — a short, autoincremental integer
 * two users can compare directly to tell whose install is newer.
 */
function BuildIdentityCard() {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard.writeText(BUILD_INFO.label).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="settings-card">
      <div className="px-4 py-3.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <p className="settings-row-title">Build</p>
            <Badge
              variant="outline"
              className="h-5 px-2 text-[10px]"
              data-testid="system-build-number"
            >
              #{BUILD_INFO.build}
            </Badge>
            {BUILD_INFO.dirty && (
              <Badge
                variant="outline"
                className="h-5 border-yellow-500/30 px-2 text-[10px] text-yellow-500"
              >
                dirty
              </Badge>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={copy} data-testid="system-build-copy">
            {copied ? (
              <CircleCheck className="icon-sm text-green-500" />
            ) : (
              <Copy className="icon-sm" />
            )}
          </Button>
        </div>

        <p className="settings-row-desc mt-1">
          Compare this between two installs to tell who has the newer build — the number grows by
          one with every commit.
        </p>

        <code
          className="bg-muted mt-3 block rounded px-3 py-2 text-xs"
          data-testid="system-build-label"
        >
          {BUILD_INFO.label}
        </code>
      </div>
    </div>
  );
}
