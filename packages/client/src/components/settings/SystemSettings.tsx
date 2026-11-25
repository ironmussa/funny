import { RefreshCw, Hammer, CircleCheck, CircleX, CircleIcon, Copy } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { SettingAnchor } from '@/components/settings/SettingRow';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { LoadingState } from '@/components/ui/loading-state';
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
  fg: 'hsl(var(--foreground))',
  bg: 'transparent',
  newline: true,
});

function nativeGitBadgeVariant(
  isActive: boolean | undefined,
  disabled: boolean | undefined,
): 'success' | 'warning' | 'secondary' {
  if (isActive) return 'success';
  if (disabled) return 'warning';
  return 'secondary';
}

export function SystemSettings() {
  const [nativeGit, setNativeGit] = useState<NativeGitInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const { buildOutput, buildStatus, clearBuild } = useNativeGitStore();
  const scrollRef = useRef<HTMLDivElement>(null);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    const result = await Promise.resolve(api.setupStatus()).finally(() => setLoading(false));
    if (result.isOk() && result.value.nativeGit) setNativeGit(result.value.nativeGit);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await api.setupStatus();
      if (cancelled) return;
      if (result.isOk() && result.value.nativeGit) setNativeGit(result.value.nativeGit);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-scroll build output
  useEffect(() => {
    if (buildOutput && scrollRef.current) {
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
        <LoadingState label="Loading…" />
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
        <SettingAnchor settingId="system.native-git" className="px-4 py-3.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <p className="settings-row-title">Native Git (gitoxide)</p>
              {nativeGit && (
                <Badge
                  variant={nativeGitBadgeVariant(isActive, nativeGit.disabled)}
                  size="xxs"
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
                  <span className="text-status-success flex items-center gap-1">
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
                <p className="text-status-warning text-xs">
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
                <CircleIcon className="fill-status-warning text-status-warning size-3 animate-pulse" />
                <span className="text-xs font-medium">Building…</span>
              </div>
            </div>
          )}

          {/* Build result */}
          {buildSucceeded && (
            <div className="mt-4 space-y-2">
              <div className="text-status-success flex items-center gap-2">
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
              <ScrollArea variant="muted-outline" className="h-64">
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
        </SettingAnchor>
      </div>

      {/* Build identity — compare this between two installs to tell who has the newer build */}
      <BuildIdentityCard />
    </div>
  );
}

/**
 * Shows the git-derived build identity injected at build time (`__BUILD_INFO__`).
 * The identity is the short commit SHA — the one value that is identical between
 * a local build and the deployed server for the same commit (the commit count
 * can't be reproduced on Railway's shallow clone, so it isn't shown here).
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
      <SettingAnchor settingId="system.build" className="px-4 py-3.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <p className="settings-row-title">Build</p>
            <Badge size="xxs" variant="outline" mono data-testid="system-build-number">
              {/* Canonical identity = short commit SHA. Identical in local and
                  in the Railway deploy for the same commit. */}
              {BUILD_INFO.commit}
            </Badge>
            {BUILD_INFO.dirty && (
              <Badge variant="warning" size="xxs">
                dirty
              </Badge>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={copy} data-testid="system-build-copy">
            {copied ? (
              <CircleCheck className="icon-sm text-status-success" />
            ) : (
              <Copy className="icon-sm" />
            )}
          </Button>
        </div>

        <p className="settings-row-desc mt-1">
          The commit this build was made from. Compare it between two installs — including the
          deployed server — to tell whether they are running the exact same code.
        </p>

        <code
          className="bg-muted mt-3 block rounded px-3 py-2 text-xs"
          data-testid="system-build-label"
        >
          {BUILD_INFO.label}
        </code>
      </SettingAnchor>
    </div>
  );
}
