/**
 * SandboxManager — ensures every pipeline agent runs inside a Podman container.
 *
 * Uses `spawnClaudeCodeProcess` from the Claude Agent SDK to redirect the
 * Claude Code subprocess into a running container via `podman exec`.
 *
 * The worktree files are COPIED (not bind-mounted) into the container and
 * a fresh `git clone --no-checkout` + `git checkout` is performed so the
 * container owns its own `.git` directory. This avoids cross-platform path
 * issues (Windows ↔ Linux) and permission problems with bind-mounted `.git`
 * pointers that plagued the previous approach.
 */

import { spawn, execSync, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import { homedir } from 'os';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { execute } from '../git/process.js';
import type { SandboxState, SandboxManagerOptions } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCKERFILE_PATH = resolve(__dirname, 'Dockerfile.sandbox');
const DEFAULT_IMAGE_NAME = 'funny-sandbox';
const CONTAINER_WORKSPACE = '/workspace';
const CONTAINER_SDK_PATH = '/opt/claude-sdk';
const CONTAINER_SOURCE_MOUNT = '/mnt/source';

// Common Podman install locations per platform (use forward slashes — works on all OSes)
const PODMAN_SEARCH_PATHS =
  process.platform === 'win32'
    ? [
        'C:/Program Files/RedHat/Podman/podman.exe',
        `${process.env.LOCALAPPDATA}/Programs/Podman/podman.exe`,
        `${process.env.ProgramFiles}/RedHat/Podman/podman.exe`,
      ]
    : ['/usr/bin/podman', '/usr/local/bin/podman', '/opt/homebrew/bin/podman'];

/**
 * Resolve the host path to the Claude Agent SDK directory.
 * Uses createRequire to find the package.json, then takes its parent dir.
 */
function resolveHostSdkPath(): string {
  const require = createRequire(import.meta.url);
  const sdkPkgJson = require.resolve('@anthropic-ai/claude-agent-sdk/package.json');
  return dirname(sdkPkgJson);
}

/**
 * Get the current branch name from a git working directory.
 */
async function getHostBranch(worktreePath: string): Promise<string | null> {
  try {
    const result = await execute('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: worktreePath,
      reject: false,
      timeout: 10_000,
    });
    const branch = result.stdout.trim();
    return branch && result.exitCode === 0 ? branch : null;
  } catch {
    return null;
  }
}

/**
 * Get the remote origin URL from a git working directory.
 */
async function getHostRemoteUrl(worktreePath: string): Promise<string | null> {
  try {
    const result = await execute('git', ['remote', 'get-url', 'origin'], {
      cwd: worktreePath,
      reject: false,
      timeout: 10_000,
    });
    const url = result.stdout.trim();
    return url && result.exitCode === 0 ? url : null;
  } catch {
    return null;
  }
}

/**
 * Find the Podman executable. Checks $PATH first, then common install locations.
 */
function findPodman(): string | null {
  // Try $PATH first
  try {
    const cmd = process.platform === 'win32' ? 'where podman' : 'which podman';
    const result = execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (result) return result.split('\n')[0].trim();
  } catch {
    // Not in PATH
  }

  // Check common locations
  for (const p of PODMAN_SEARCH_PATHS) {
    if (p && existsSync(p)) return p;
  }

  return null;
}

export class SandboxManager {
  private activeSandboxes = new Map<string, SandboxState>();
  private readonly imageName: string;
  private imageReady = false;
  private hostSdkPath: string | null = null;
  private podmanPath: string | null | undefined = undefined; // undefined = not checked yet

  constructor(options: SandboxManagerOptions = {}) {
    this.imageName = options.imageName ?? DEFAULT_IMAGE_NAME;
  }

  // ── Podman detection ───────────────────────────────────────────

  /**
   * Find and cache the Podman executable path.
   * Returns the full path or null if not found.
   */
  private getPodmanPath(): string | null {
    if (this.podmanPath === undefined) {
      this.podmanPath = findPodman();
      if (this.podmanPath) {
        console.log(`[sandbox] Podman found at: ${this.podmanPath}`);
      }
    }
    return this.podmanPath;
  }

  /**
   * Check if Podman is installed.
   * Result is cached after the first check.
   */
  async isPodmanAvailable(): Promise<boolean> {
    return this.getPodmanPath() !== null;
  }

  /**
   * Get the Podman executable path, throwing if not found.
   */
  private requirePodman(): string {
    const p = this.getPodmanPath();
    if (!p) {
      throw new Error(
        'Podman is required but was not found. ' +
          'Install it from https://podman.io/docs/installation',
      );
    }
    return p;
  }

  // ── Image management ───────────────────────────────────────────

  /**
   * Build the sandbox image if it doesn't exist yet.
   * Called lazily on the first pipeline run.
   */
  async ensureImage(): Promise<string> {
    if (this.imageReady) return this.imageName;

    const podman = this.requirePodman();

    // Check if image already exists
    const check = await execute(podman, ['image', 'exists', this.imageName], { reject: false });

    if (check.exitCode === 0) {
      this.imageReady = true;
      return this.imageName;
    }

    console.log(`[sandbox] Building image ${this.imageName}...`);
    await execute(
      podman,
      ['build', '-t', this.imageName, '-f', DOCKERFILE_PATH, dirname(DOCKERFILE_PATH)],
      { timeout: 120_000 },
    );

    this.imageReady = true;
    console.log(`[sandbox] Image ${this.imageName} ready`);
    return this.imageName;
  }

  /**
   * Resolve and cache the host path to the Claude Agent SDK.
   */
  private getHostSdkPath(): string {
    if (!this.hostSdkPath) {
      this.hostSdkPath = resolveHostSdkPath();
      console.log(`[sandbox] Resolved SDK path: ${this.hostSdkPath}`);
    }
    return this.hostSdkPath;
  }

  // ── Container lifecycle ────────────────────────────────────────

  /**
   * Start a sandbox container by:
   *  1. Mounting the worktree read-only at /mnt/source
   *  2. Copying files (excluding .git) into /workspace
   *  3. Cloning the repo's git history via `git clone --no-checkout` + `git checkout`
   *
   * This gives the container its own `.git` directory, avoiding cross-platform
   * path issues and permission problems with bind-mounted worktree pointers.
   */
  async startSandbox(opts: {
    requestId: string;
    worktreePath: string;
    env?: Record<string, string>;
  }): Promise<SandboxState> {
    const { requestId, worktreePath, env } = opts;
    const containerName = `pipeline-sandbox-${requestId}`;
    const podman = this.requirePodman();

    const state: SandboxState = {
      containerId: '',
      containerName,
      requestId,
      worktreePath,
      status: 'starting',
    };
    this.activeSandboxes.set(requestId, state);

    try {
      await this.ensureImage();

      const sdkPath = this.getHostSdkPath();

      // Mount ~/.claude config so the child process can access auth tokens and settings
      const hostClaudeDir = join(homedir(), '.claude');
      const containerHome = '/home/sandbox';

      // Get branch name and remote URL from the host before starting the container
      const [branch, remoteUrl] = await Promise.all([
        getHostBranch(worktreePath),
        getHostRemoteUrl(worktreePath),
      ]);
      console.log(`[sandbox] Host branch=${branch}, remoteUrl=${remoteUrl}`);

      // Build podman run args — mount worktree as READ-ONLY at /mnt/source
      const runArgs = [
        'run',
        '-d',
        '--name',
        containerName,
        '-v',
        `${worktreePath}:${CONTAINER_SOURCE_MOUNT}:ro`,
        '-v',
        `${sdkPath}:${CONTAINER_SDK_PATH}:ro`,
        ...(existsSync(hostClaudeDir) ? ['-v', `${hostClaudeDir}:${containerHome}/.claude`] : []),
        '-w',
        CONTAINER_WORKSPACE,
      ];

      // Pass through environment variables the agent needs
      const envVars: Record<string, string> = {
        ...env,
      };

      // Forward ANTHROPIC_API_KEY if set on host
      if (process.env.ANTHROPIC_API_KEY) {
        envVars.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
      }

      for (const [key, value] of Object.entries(envVars)) {
        runArgs.push('-e', `${key}=${value}`);
      }

      runArgs.push(this.imageName, 'sleep', 'infinity');

      console.log(`[sandbox] Starting container ${containerName} for request=${requestId}`);

      const result = await execute(podman, runArgs, { timeout: 60_000 });
      state.containerId = result.stdout.trim();
      state.status = 'running';

      console.log(
        `[sandbox] Container ${containerName} running (id=${state.containerId.slice(0, 12)})`,
      );

      // Set safe.directory so git doesn't complain about ownership
      await execute(
        podman,
        [
          'exec',
          '--user',
          'sandbox',
          containerName,
          'git',
          'config',
          '--global',
          'safe.directory',
          '*',
        ],
        { reject: false, timeout: 10_000 },
      );

      // Copy worktree files (excluding .git) from read-only mount to /workspace.
      // Run as root first to copy, then chown to sandbox user.
      console.log(`[sandbox] Copying worktree files to ${CONTAINER_WORKSPACE}...`);
      const copyResult = await execute(
        podman,
        [
          'exec',
          containerName,
          'sh',
          '-c',
          // Use rsync-like copy: cp -a copies recursively preserving attributes,
          // --exclude .git skips the worktree's .git pointer file.
          // We use find + cp to skip .git since cp doesn't have --exclude.
          `cd ${CONTAINER_SOURCE_MOUNT} && find . -mindepth 1 -maxdepth 1 ! -name .git -exec cp -a {} ${CONTAINER_WORKSPACE}/ \\; && chown -R sandbox:sandbox ${CONTAINER_WORKSPACE}`,
        ],
        { reject: false, timeout: 120_000 },
      );
      console.log(
        `[sandbox] Copy files: exit=${copyResult.exitCode} stderr=${copyResult.stderr.slice(0, 200)}`,
      );

      if (copyResult.exitCode !== 0) {
        throw new Error(`Failed to copy worktree files: ${copyResult.stderr}`);
      }

      // Initialize git repo inside the container
      if (remoteUrl) {
        // Clone approach: init repo, add remote, fetch, and checkout the branch
        console.log(`[sandbox] Initializing git repo with remote=${remoteUrl} branch=${branch}`);

        // git init + add remote + fetch
        const gitInitScript = [
          `cd ${CONTAINER_WORKSPACE}`,
          'git init',
          `git remote add origin "${remoteUrl}"`,
          `git fetch origin ${branch || 'HEAD'} --depth=50`,
          // Set the branch to track the remote
          branch ? `git checkout -b ${branch} FETCH_HEAD` : 'git checkout FETCH_HEAD',
          // Stage all current files so `git status` shows a clean tree
          'git add -A',
          // Reset to match the fetched commit — working tree already has the right files
          'git reset HEAD',
        ].join(' && ');

        const initResult = await execute(
          podman,
          ['exec', '--user', 'sandbox', containerName, 'sh', '-c', gitInitScript],
          { reject: false, timeout: 120_000 },
        );
        console.log(
          `[sandbox] Git init+fetch: exit=${initResult.exitCode} stderr=${initResult.stderr.slice(0, 500)}`,
        );

        if (initResult.exitCode !== 0) {
          console.warn(`[sandbox] Git clone approach failed, falling back to local-only init`);
          await this.fallbackGitInit(podman, containerName, branch);
        }
      } else {
        // No remote — just init a local repo
        console.log(`[sandbox] No remote URL found, initializing local-only git repo`);
        await this.fallbackGitInit(podman, containerName, branch);
      }

      // Verify git is working
      const verifyGitStatus = await execute(
        podman,
        [
          'exec',
          '--user',
          'sandbox',
          containerName,
          'git',
          '-C',
          CONTAINER_WORKSPACE,
          'status',
          '--short',
        ],
        { reject: false, timeout: 10_000 },
      );
      console.log(
        `[sandbox] Verify git status: exit=${verifyGitStatus.exitCode} stdout=${verifyGitStatus.stdout.slice(0, 200)} stderr=${verifyGitStatus.stderr.slice(0, 200)}`,
      );

      const verifyBranch = await execute(
        podman,
        [
          'exec',
          '--user',
          'sandbox',
          containerName,
          'git',
          '-C',
          CONTAINER_WORKSPACE,
          'branch',
          '--show-current',
        ],
        { reject: false, timeout: 10_000 },
      );
      console.log(`[sandbox] Container branch: ${verifyBranch.stdout.trim()}`);

      return state;
    } catch (error: any) {
      state.status = 'failed';
      console.error(`[sandbox] Failed to start container for request=${requestId}:`, error.message);
      this.activeSandboxes.delete(requestId);
      throw error;
    }
  }

  /**
   * Fallback: init a local git repo with all files committed.
   * Used when no remote URL is available or fetch fails.
   */
  private async fallbackGitInit(
    podman: string,
    containerName: string,
    branch: string | null,
  ): Promise<void> {
    const script = [
      `cd ${CONTAINER_WORKSPACE}`,
      'git init',
      branch ? `git checkout -b ${branch}` : '',
      'git add -A',
      'git commit -m "Initial commit (sandbox snapshot)"',
    ]
      .filter(Boolean)
      .join(' && ');

    const result = await execute(
      podman,
      ['exec', '--user', 'sandbox', containerName, 'sh', '-c', script],
      { reject: false, timeout: 60_000 },
    );
    console.log(
      `[sandbox] Fallback git init: exit=${result.exitCode} stderr=${result.stderr.slice(0, 200)}`,
    );
  }

  /**
   * Stop and remove a sandbox container.
   * Since files are copied (not bind-mounted), no host cleanup is needed.
   */
  async stopSandbox(requestId: string): Promise<void> {
    const state = this.activeSandboxes.get(requestId);
    if (!state) return;

    state.status = 'stopping';
    console.log(`[sandbox] Stopping container ${state.containerName}`);

    const podman = this.getPodmanPath();
    if (!podman) return;

    try {
      await execute(podman, ['rm', '-f', state.containerName], { reject: false, timeout: 30_000 });
    } catch (error: any) {
      console.warn(`[sandbox] Error removing container: ${error.message}`);
    }

    state.status = 'stopped';
    this.activeSandboxes.delete(requestId);
  }

  // ── SDK integration ────────────────────────────────────────────

  /**
   * Create a `spawnClaudeCodeProcess` function for the SDK.
   *
   * The returned function intercepts the SDK's process spawn and remaps
   * host paths to container paths, then runs the command inside the
   * sandbox container via `podman exec`.
   *
   * Node's ChildProcess already satisfies the SDK's SpawnedProcess interface.
   */
  createSpawnFn(
    requestId: string,
  ): (options: {
    command: string;
    args: string[];
    cwd?: string;
    env: Record<string, string | undefined>;
    signal: AbortSignal;
  }) => ChildProcess {
    const state = this.activeSandboxes.get(requestId);
    if (!state) {
      throw new Error(`[sandbox] No active sandbox for request=${requestId}`);
    }

    const containerName = state.containerName;
    const sdkHostPath = this.getHostSdkPath();
    const podman = this.requirePodman();

    return (options) => {
      console.log(`[sandbox] spawnClaudeCodeProcess: ${options.command} (cwd=${options.cwd})`);

      // Rewrite args: replace host SDK paths with container mount path
      // Normalize backslashes to forward slashes for cross-platform matching
      const normalizedSdkPath = sdkHostPath.replace(/\\/g, '/');
      const rewrittenArgs = options.args.map((arg) => {
        const normalizedArg = arg.replace(/\\/g, '/');
        if (normalizedArg.includes(normalizedSdkPath)) {
          return normalizedArg.replace(normalizedSdkPath, CONTAINER_SDK_PATH);
        }
        return arg;
      });

      // Build the podman exec command — run as non-root user to allow --dangerously-skip-permissions
      const execArgs = ['exec', '-i', '--user', 'sandbox'];

      // Pass environment variables into exec.
      // Override host-specific paths so Claude Code works inside the container.
      const envOverrides: Record<string, string> = {
        HOME: '/home/sandbox',
        USERPROFILE: '/home/sandbox',
        TMPDIR: '/tmp',
        TEMP: '/tmp',
        TMP: '/tmp',
      };
      // Skip host-only env vars that don't apply inside the container
      const skipEnvKeys = new Set([
        'PATH',
        'SHELL',
        'TERM',
        'LANG',
        'HOSTNAME',
        'PROGRAMFILES',
        'PROGRAMDATA',
        'APPDATA',
        'LOCALAPPDATA',
        'SYSTEMROOT',
        'WINDIR',
        'COMSPEC',
        'PATHEXT',
        'npm_config_prefix',
        'NVM_DIR',
        'NVM_HOME',
      ]);
      for (const [key, value] of Object.entries(options.env)) {
        if (value !== undefined && !(key in envOverrides) && !skipEnvKeys.has(key)) {
          execArgs.push('-e', `${key}=${value}`);
        }
      }
      for (const [key, value] of Object.entries(envOverrides)) {
        execArgs.push('-e', `${key}=${value}`);
      }

      // Set working directory inside container
      if (options.cwd) {
        execArgs.push('-w', options.cwd);
      }

      execArgs.push(containerName, options.command, ...rewrittenArgs);

      const child = spawn(podman, execArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Handle abort signal — kill the exec'd process
      const onAbort = () => {
        child.kill('SIGTERM');
      };

      if (options.signal.aborted) {
        child.kill('SIGTERM');
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
        child.once('exit', () => {
          options.signal.removeEventListener('abort', onAbort);
        });
      }

      return child;
    };
  }

  // ── Queries ────────────────────────────────────────────────────

  getState(requestId: string): SandboxState | undefined {
    return this.activeSandboxes.get(requestId);
  }

  // ── Shutdown ───────────────────────────────────────────────────

  /**
   * Stop all running sandbox containers. Called during server shutdown.
   */
  async stopAll(): Promise<void> {
    const entries = [...this.activeSandboxes.keys()];
    if (entries.length === 0) return;

    console.log(`[sandbox] Stopping ${entries.length} sandbox(es)...`);
    await Promise.allSettled(entries.map((requestId) => this.stopSandbox(requestId)));
    console.log('[sandbox] All sandboxes stopped.');
  }

  /**
   * Kill any orphaned pipeline-sandbox-* containers from previous runs.
   * Call on startup to clean up after crashes or ungraceful shutdowns.
   */
  async killOrphans(): Promise<number> {
    const podman = this.getPodmanPath();
    if (!podman) return 0;

    try {
      // List all containers matching our naming pattern
      const result = await execute(
        podman,
        ['ps', '-a', '--filter', 'name=pipeline-sandbox-', '--format', '{{.Names}}'],
        { reject: false, timeout: 15_000 },
      );

      const names = result.stdout
        .split('\n')
        .map((n) => n.trim())
        .filter((n) => n.length > 0);

      if (names.length === 0) return 0;

      console.log(`[sandbox] Found ${names.length} orphaned container(s), removing...`);
      await execute(podman, ['rm', '-f', ...names], { reject: false, timeout: 30_000 });
      console.log(`[sandbox] Removed ${names.length} orphaned container(s): ${names.join(', ')}`);
      return names.length;
    } catch (err: any) {
      console.warn(`[sandbox] Failed to clean up orphaned containers: ${err.message}`);
      return 0;
    }
  }
}
