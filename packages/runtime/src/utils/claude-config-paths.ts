import { homedir } from 'os';
import { normalize, resolve } from 'path';

/** Claude Code user settings files that may be edited via the internal file editor. */
export const CLAUDE_HOME_CONFIG_REL_PATHS = [
  '.claude/settings.json',
  '.claude/settings.local.json',
] as const;

/**
 * When `targetPath` is an allowed Claude settings file under `home`, returns the
 * directory used as the authorization scope for read/write (the `.claude` folder).
 */
export function resolveClaudeHomeConfigScope(
  targetPath: string,
  home: string = homedir(),
): { scopeDir: string; configPath: string } | null {
  const normalizedTarget = normalize(resolve(targetPath));
  const normalizedHome = normalize(resolve(home));

  for (const rel of CLAUDE_HOME_CONFIG_REL_PATHS) {
    const allowed = normalize(resolve(normalizedHome, rel));
    if (normalizedTarget === allowed) {
      return { scopeDir: normalize(resolve(normalizedHome, '.claude')), configPath: allowed };
    }
  }
  return null;
}
