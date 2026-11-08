import type { NativeGitStatus } from '@funny/core/git';

interface StatusLogger {
  info(message: string, meta: Record<string, unknown>): unknown;
  warn(message: string, meta: Record<string, unknown>): unknown;
}

/**
 * Report at startup whether git reads go through gitoxide (`@funny/native-git`)
 * or the much slower git CLI fallback. The fallback used to be silent, which
 * hid production runners that shipped without the native binary.
 */
export function reportNativeGitStatus(status: NativeGitStatus, logger: StatusLogger): void {
  const meta = { namespace: 'native-git' };
  switch (status.state) {
    case 'loaded':
      logger.info('Native git (gitoxide) loaded', meta);
      return;
    case 'disabled':
      logger.info('Native git disabled by FUNNY_DISABLE_NATIVE_GIT=1; using the git CLI', meta);
      return;
    case 'unavailable':
      logger.warn(
        'Native git (gitoxide) is unavailable; falling back to the git CLI, which spawns ' +
          'several git processes per status read. Build it with `bun run build:native` ' +
          'before building the runtime.',
        { ...meta, error: status.error },
      );
  }
}
