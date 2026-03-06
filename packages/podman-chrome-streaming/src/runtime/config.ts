import { existsSync, readFileSync } from 'fs';

import type { ResolvedGitCredentials, RuntimeConfig } from './types.ts';

/**
 * Build a RuntimeConfig from environment variables.
 *
 * Required for remote runtime:
 *   REPO_MODE=clone + REPO_URL
 *
 * Optional:
 *   REPO_REF, WORK_BRANCH, GIT_TOKEN, GIT_TOKEN_FILE, GIT_USERNAME,
 *   WORKSPACE_PATH, FUNNY_PORT, CLIENT_ORIGIN, AUTH_MODE,
 *   ENABLE_RUNTIME, ENABLE_STREAMING, STREAM_HTTP_PORT, STREAM_WS_PORT,
 *   NOVNC_PORT, CHROME_DEBUG_PORT, START_URL, FUNNY_DATA_DIR
 */
export function configFromEnv(): RuntimeConfig {
  const repoMode = (process.env.REPO_MODE ?? 'clone') as RuntimeConfig['repoMode'];
  const enableRuntime = parseBoolean(process.env.ENABLE_RUNTIME, true);
  const repoUrl = process.env.REPO_URL;

  if (enableRuntime && repoMode === 'clone' && !repoUrl) {
    throw new Error('REPO_URL environment variable is required when REPO_MODE=clone');
  }

  return {
    repoMode,
    repoUrl,
    repoRef: process.env.REPO_REF || undefined,
    workBranch: process.env.WORK_BRANCH || undefined,
    gitToken: process.env.GIT_TOKEN || undefined,
    gitTokenFile: process.env.GIT_TOKEN_FILE || undefined,
    gitUsername: process.env.GIT_USERNAME || 'x-access-token',
    workspacePath: process.env.WORKSPACE_PATH || '/workspace/repo',
    funnyPort: parseNumber(process.env.FUNNY_PORT, 3001),
    clientOrigin: process.env.CLIENT_ORIGIN || undefined,
    authMode: (process.env.AUTH_MODE as RuntimeConfig['authMode']) || 'local',
    funnyDataDir: process.env.FUNNY_DATA_DIR || '/workspace/.funny-data',
    enableRuntime,
    enableStreaming: parseBoolean(process.env.ENABLE_STREAMING, true),
    streamViewerPort: parseNumber(process.env.STREAM_HTTP_PORT ?? process.env.HTTP_PORT, 3500),
    streamWsPort: parseNumber(process.env.STREAM_WS_PORT ?? process.env.WS_PORT, 3501),
    novncPort: parseNumber(process.env.NOVNC_PORT, 6080),
    chromeDebugPort: parseNumber(process.env.CHROME_DEBUG_PORT ?? process.env.CHROME_PORT, 9222),
    startUrl: process.env.START_URL || 'https://example.com',
  };
}

/**
 * Resolve Git credentials from config.
 *
 * Precedence:
 *  1. git.tokenFile (path to a file containing the token, from GIT_TOKEN_FILE env)
 *  2. git.token (direct value, from GIT_TOKEN env)
 *  3. null (public repo, no credentials)
 */
export function resolveGitCredentials(config: RuntimeConfig): ResolvedGitCredentials | null {
  let token: string | undefined;

  if (config.gitTokenFile) {
    if (!existsSync(config.gitTokenFile)) {
      throw new Error(`GIT_TOKEN_FILE not found: ${config.gitTokenFile}`);
    }
    token = readFileSync(config.gitTokenFile, 'utf-8').trim();
  } else if (config.gitToken) {
    token = config.gitToken;
  }

  if (!token) return null;

  return {
    token,
    username: config.gitUsername,
  };
}

/**
 * Inject credentials into an HTTPS git URL.
 * Embeds the username and token into the URL authority section.
 */
export function buildAuthenticatedUrl(
  repoUrl: string,
  credentials: ResolvedGitCredentials,
): string {
  const url = new URL(repoUrl);
  url.username = credentials.username;
  url.password = credentials.token;
  return url.toString();
}

export function redactGitUrl(value: string): string {
  return value.replace(/\/\/([^:/\s]+):([^@\s]+)@/g, '//***:***@');
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null || value === '') return defaultValue;
  return !['0', 'false', 'no', 'off'].includes(value.toLowerCase());
}

function parseNumber(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) return defaultValue;
  return parsed;
}
