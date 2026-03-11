/**
 * @domain subdomain: Process Management
 * @domain subdomain-type: supporting
 * @domain type: service
 * @domain layer: infrastructure
 *
 * Detects available shell executables on the system.
 * Works on Linux, macOS, and Windows.
 */

import { existsSync, readFileSync } from 'fs';

import { log } from '../lib/logger.js';

export interface DetectedShell {
  id: string;
  label: string;
  path: string;
}

const isWindows = process.platform === 'win32';

/** Cache detected shells — they don't change within a server session. */
let cachedShells: DetectedShell[] | null = null;

/** Check if a binary exists and is executable. */
function binaryExists(path: string): boolean {
  try {
    if (isWindows) {
      // On Windows, use `where.exe` to check PATH-based commands
      if (!path.includes('\\') && !path.includes('/')) {
        const r = Bun.spawnSync(['where.exe', path], { stdout: 'pipe', stderr: 'pipe' });
        return r.exitCode === 0;
      }
      return existsSync(path);
    }
    // On POSIX, use `command -v`
    const r = Bun.spawnSync(['sh', '-c', `command -v "${path}"`], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

/** Resolve the actual path of a binary using `command -v` or `where.exe`. */
function resolveBinaryPath(name: string): string | null {
  try {
    if (isWindows) {
      const r = Bun.spawnSync(['where.exe', name], { stdout: 'pipe', stderr: 'pipe' });
      if (r.exitCode === 0) {
        return r.stdout.toString().trim().split('\n')[0]?.trim() ?? null;
      }
      return null;
    }
    const r = Bun.spawnSync(['sh', '-c', `command -v "${name}"`], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (r.exitCode === 0) {
      return r.stdout.toString().trim() || null;
    }
    return null;
  } catch {
    return null;
  }
}

/** Detect shells on Linux/macOS. */
function detectPosixShells(): DetectedShell[] {
  const shells: DetectedShell[] = [];
  const seen = new Set<string>();

  // Terminal multiplexers listed in /etc/shells are not interactive shells
  const multiplexers = new Set(['tmux', 'screen', 'zellij', 'abduco', 'dtach']);

  // Read /etc/shells for the system-declared shells
  try {
    const content = readFileSync('/etc/shells', 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const name = trimmed.split('/').pop() ?? '';
      if (seen.has(name)) continue;
      if (multiplexers.has(name)) continue; // skip terminal multiplexers
      seen.add(name);

      shells.push({
        id: name,
        label: shellDisplayName(name),
        path: trimmed,
      });
    }
  } catch {
    // /etc/shells may not exist on some systems; fall back to probing
  }

  // Probe for common shells not in /etc/shells
  const extraShells = [
    'bash',
    'zsh',
    'fish',
    'sh',
    'dash',
    'ksh',
    'tcsh',
    'nushell',
    'nu',
    'elvish',
  ];
  for (const name of extraShells) {
    if (seen.has(name)) continue;
    const resolved = resolveBinaryPath(name);
    if (resolved) {
      seen.add(name);
      shells.push({
        id: name,
        label: shellDisplayName(name),
        path: resolved,
      });
    }
  }

  return shells;
}

/** Detect shells on Windows. */
function detectWindowsShells(): DetectedShell[] {
  const shells: DetectedShell[] = [];

  // PowerShell (always available on Windows)
  if (binaryExists('powershell.exe')) {
    const path = resolveBinaryPath('powershell.exe');
    shells.push({ id: 'powershell', label: 'Windows PowerShell', path: path ?? 'powershell.exe' });
  }

  // PowerShell Core (pwsh)
  if (binaryExists('pwsh.exe')) {
    const path = resolveBinaryPath('pwsh.exe');
    shells.push({ id: 'pwsh', label: 'PowerShell Core', path: path ?? 'pwsh.exe' });
  }

  // CMD
  if (binaryExists('cmd.exe')) {
    const path = resolveBinaryPath('cmd.exe');
    shells.push({ id: 'cmd', label: 'Command Prompt', path: path ?? 'cmd.exe' });
  }

  // Git Bash — check common install paths
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const gitBashPaths = [
    `${programFiles}\\Git\\bin\\bash.exe`,
    `${programFiles}\\Git\\usr\\bin\\bash.exe`,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ];
  for (const p of gitBashPaths) {
    if (existsSync(p)) {
      shells.push({ id: 'git-bash', label: 'Git Bash', path: p });
      break;
    }
  }

  // WSL
  if (binaryExists('wsl.exe')) {
    const path = resolveBinaryPath('wsl.exe');
    shells.push({ id: 'wsl', label: 'WSL', path: path ?? 'wsl.exe' });
  }

  return shells;
}

/** Get a human-friendly display name for a shell binary name. */
function shellDisplayName(name: string): string {
  const map: Record<string, string> = {
    bash: 'Bash',
    zsh: 'Zsh',
    fish: 'Fish',
    sh: 'sh',
    dash: 'Dash',
    ksh: 'KornShell',
    tcsh: 'tcsh',
    csh: 'csh',
    nushell: 'Nushell',
    nu: 'Nushell',
    elvish: 'Elvish',
    powershell: 'Windows PowerShell',
    pwsh: 'PowerShell Core',
    cmd: 'Command Prompt',
  };
  return map[name] ?? name;
}

/** Detect all available shells on the current system. Results are cached. */
export function detectShells(): DetectedShell[] {
  if (cachedShells) return cachedShells;

  const shells = isWindows ? detectWindowsShells() : detectPosixShells();

  log.info('Detected available shells', {
    namespace: 'shell-detector',
    count: shells.length,
    shells: shells.map((s) => s.id),
  });

  cachedShells = shells;
  return shells;
}

/** Clear the shell cache (useful for testing or after system changes). */
export function clearShellCache(): void {
  cachedShells = null;
}
