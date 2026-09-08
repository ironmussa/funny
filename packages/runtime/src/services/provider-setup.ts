import { spawn } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { delimiter, dirname, join } from 'path';

import { DATA_DIR } from '../lib/data-dir.js';
import { resetBinaryCache } from '../utils/claude-binary.js';
import { bundledCodexBinary } from '../utils/codex-binary.js';
import { getAvailableProviders, resetProviderCache } from '../utils/provider-detection.js';

// Only these packages can be installed by the UI. Never execute a client-supplied command.
export const PROVIDER_INSTALLS = {
  claude: { package: '@anthropic-ai/claude-code', binary: 'claude', login: 'claude auth login' },
  codex: { package: '@openai/codex', binary: 'codex', login: 'codex login --device-auth' },
  pi: { package: '@earendil-works/pi-coding-agent', binary: 'pi', login: 'pi' },
  gemini: { package: '@google/gemini-cli', binary: 'gemini', login: 'gemini' },
  cursor: { package: null, binary: 'cursor-agent', login: 'cursor-agent login' },
  opencode: { package: 'opencode-ai', binary: 'opencode', login: 'opencode auth login' },
} as const;

type ProviderId = keyof typeof PROVIDER_INSTALLS;
type InstallState = { state: 'installing' | 'installed' | 'failed'; error?: string };
const jobs = new Map<string, InstallState>();
const installRoot = join(DATA_DIR, 'provider-tools');
const binDir = join(installRoot, 'node_modules', '.bin');

export function isInstallableProvider(id: string): id is ProviderId {
  return Object.hasOwn(PROVIDER_INSTALLS, id);
}

export function activateProviderTools(): void {
  process.env.PATH = [
    ...new Set([
      binDir,
      dirname(process.execPath),
      join(homedir(), '.local', 'bin'),
      ...(process.env.PATH ?? '').split(delimiter),
    ]),
  ].join(delimiter);
  const installedCodex = join(binDir, 'codex');
  const codex = existsSync(installedCodex) ? installedCodex : bundledCodexBinary();
  if (codex && !process.env.CODEX_BINARY_PATH && !process.env.CODEX_BIN) {
    process.env.CODEX_BINARY_PATH = codex;
  }
  const cursor =
    Bun.which('cursor-agent', { PATH: process.env.PATH }) ??
    Bun.which(join(homedir(), '.local', 'bin', 'agent'));
  if (cursor && !process.env.CURSOR_BINARY_PATH && !process.env.ACP_CURSOR_BIN) {
    process.env.CURSOR_BINARY_PATH = cursor;
  }
  resetProviderCache();
  resetBinaryCache();
}

export type ProviderAuthState = 'connected' | 'required' | 'unknown' | 'configured';

interface ProviderSetupStatus {
  auth: ProviderAuthState;
  loginCommand?: string;
  loginShell?: string;
  provider: string;
  state: 'manual' | 'missing' | 'bundled' | 'installing' | 'installed' | 'failed';
  installable: boolean;
  login: string | null;
  error?: string;
}

function providerBinary(id: ProviderId): string | null {
  const overrides: Partial<Record<ProviderId, string | undefined>> = {
    claude: process.env.CLAUDE_BINARY_PATH,
    codex: process.env.CODEX_BINARY_PATH ?? process.env.CODEX_BIN,
    gemini: process.env.GEMINI_BINARY_PATH ?? process.env.ACP_GEMINI_BIN,
    cursor: process.env.CURSOR_BINARY_PATH ?? process.env.ACP_CURSOR_BIN,
  };
  // Bun's default lookup can retain the startup PATH after process.env.PATH changes.
  return Bun.which(overrides[id] ?? PROVIDER_INSTALLS[id].binary, { PATH: process.env.PATH });
}

function quoteShell(value: string): string {
  return "'" + value.replaceAll("'", process.platform === 'win32' ? "''" : "'\"'\"'") + "'";
}

// Only emit a fixed login operation, with runner-owned paths safely quoted.
// Restore PATH after login-shell profiles have run, including on an existing daemon.
function loginCommand(id: ProviderId, binary: string): string {
  const args = PROVIDER_INSTALLS[id].login.split(' ').slice(1).map(quoteShell).join(' ');
  const command = `${quoteShell(binary)} ${args}`;
  const instructions = quoteShell(
    'In Pi, type /login and choose your provider. After signing in, return to Funny.',
  );
  const prelude =
    id === 'pi'
      ? process.platform === 'win32'
        ? `Write-Host ${instructions}; `
        : `printf '%s\\n' ${instructions}; `
      : '';
  const path = quoteShell(process.env.PATH ?? '');
  return process.platform === 'win32'
    ? `$env:PATH=${path}; ${prelude}& ${command}`
    : `export PATH=${path}; ${prelude}NO_BROWSER=1 NO_OPEN_BROWSER=1 ${command}`;
}

export async function checkProviderAuth(
  id: ProviderId,
  binary: string | null,
  configured = false,
): Promise<ProviderAuthState> {
  const envKeys: Partial<Record<ProviderId, string[]>> = {
    claude: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'],
    codex: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
    gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    cursor: ['CURSOR_API_KEY'],
  };
  if (configured || envKeys[id]?.some((key) => Boolean(process.env[key]))) return 'configured';
  if (id === 'pi') {
    try {
      const { discoverPiModels } = await import('@funny/core/agents');
      const result = await discoverPiModels();
      // Use the same credential/model discovery as Pi execution, including OAuth and API keys.
      return result.ok ? 'configured' : result.reason === 'auth_required' ? 'required' : 'unknown';
    } catch {
      return 'unknown';
    }
  }
  if (!binary) return 'unknown';
  // These CLIs document status exit codes. Other agents complete auth interactively;
  // never claim a credential file or an installed executable is a valid session.
  const args = id === 'claude' ? ['auth', 'status'] : id === 'codex' ? ['login', 'status'] : null;
  if (!args) return 'unknown';
  return new Promise((resolve) => {
    try {
      const child = spawn(binary, args, { stdio: 'ignore', shell: false, timeout: 10_000 });
      child.once('error', () => resolve('unknown'));
      child.once('close', (code) =>
        resolve(code === 0 ? 'connected' : code === 1 ? 'required' : 'unknown'),
      );
    } catch {
      resolve('unknown');
    }
  });
}

export async function providerSetupStatus(
  id: string,
  configured = false,
): Promise<ProviderSetupStatus> {
  if (!isInstallableProvider(id)) {
    return { provider: id, state: 'manual', installable: false, login: null, auth: 'unknown' };
  }
  const job = jobs.get(id);
  if (job?.state === 'installing' || job?.state === 'failed') {
    return { provider: id, ...job, installable: true, login: null, auth: 'unknown' };
  }
  const available = await getAvailableProviders();
  const bundled = id === 'pi' || (id !== 'codex' && available.get(id)?.sdkAvailable === true);
  const binary = providerBinary(id);
  return {
    provider: id,
    state: binary ? 'installed' : bundled ? 'bundled' : 'missing',
    installable: id !== 'cursor' || process.platform !== 'win32',
    login: PROVIDER_INSTALLS[id].login,
    loginCommand: binary ? loginCommand(id, binary) : undefined,
    loginShell: process.platform === 'win32' ? 'powershell' : 'bash',
    auth: await checkProviderAuth(id, binary, configured),
  };
}

export function startProviderInstall(id: string): boolean {
  if (!isInstallableProvider(id) || (id === 'cursor' && process.platform === 'win32')) return false;
  // A single package directory is shared, so serialize package-manager writes.
  if ([...jobs.values()].some((job) => job.state === 'installing')) return false;
  jobs.set(id, { state: 'installing' });
  try {
    mkdirSync(installRoot, { recursive: true });
    activateProviderTools();
    // Bun's absolute executable is available even when npm/bun are absent from
    // a login shell's PATH. Keep packages under the persistent data directory.
    const useBun = Boolean(process.versions.bun);
    const command = id === 'cursor' ? 'bash' : useBun ? process.execPath : 'npm';
    const args =
      id === 'cursor'
        ? [
            '-o',
            'pipefail',
            '-c',
            'curl --fail --silent --show-error --location https://cursor.com/install | bash',
          ]
        : useBun
          ? // Native CLIs (including Claude) create their executable in postinstall.
            // Trust only the requested package from our fixed allowlist, including on retry.
            ['add', '--cwd', installRoot, '--trust', PROVIDER_INSTALLS[id].package!]
          : [
              'install',
              '--prefix',
              installRoot,
              '--no-audit',
              '--no-fund',
              PROVIDER_INSTALLS[id].package!,
            ];
    const child = spawn(command, args, { stdio: 'ignore', timeout: 300_000, shell: false });
    child.once('error', () =>
      jobs.set(id, {
        state: 'failed',
        error:
          'Could not start the installer. Check runner tools (Bun or npm; bash and curl for Cursor), then retry.',
      }),
    );
    child.once('close', (code) => {
      if (jobs.get(id)?.state !== 'installing') return;
      if (code !== 0) {
        jobs.set(id, {
          state: 'failed',
          error:
            'Installation failed or timed out. Check runner network access and disk space, then retry.',
        });
        return;
      }
      activateProviderTools();
      const installed = providerBinary(id);
      jobs.set(
        id,
        installed
          ? { state: 'installed' }
          : {
              state: 'failed',
              error: 'Package installed but its executable could not be found on the runner.',
            },
      );
    });
  } catch {
    jobs.set(id, {
      state: 'failed',
      error:
        'Could not prepare installation. Check runner directory permissions and npm availability, then retry.',
    });
  }
  return true;
}
