/**
 * Provider-neutral installer for the funny runner inside a sandbox
 * (change thread-sandboxes). Used both to build a provider template and to
 * install on the fly when no template is ready yet.
 *
 * It clones the server's exact commit, installs dependencies and registers a
 * systemd service that only starts once `SANDBOX_ENV_FILE` exists — the file the
 * server writes per sandbox (server URL + single-use provisioning token). A
 * template therefore contains no credentials and boots without starting a runner.
 */

import { randomUUID } from 'crypto';

import { err, errAsync, ok, okAsync, type Result, type ResultAsync } from 'neverthrow';

import type { SandboxError, SandboxHandle, SandboxProvider } from './contract.js';
import type { RunnerBuild } from './runner-build.js';

const SANDBOX_INSTALL_DIR = '/opt/funny';
export const SANDBOX_ENV_FILE = '/etc/funny/sandbox.env';
const RUNNER_SERVICE = 'funny-runner.service';
/** Marker with the installed commit; lets the server skip reinstalling. */
export const INSTALLED_COMMIT_FILE = `${SANDBOX_INSTALL_DIR}/.funny-commit`;

export const RUNNER_INSTALL_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
: "\${FUNNY_REPO_URL:?FUNNY_REPO_URL is required}"
: "\${FUNNY_COMMIT:?FUNNY_COMMIT is required}"
INSTALL_DIR="${SANDBOX_INSTALL_DIR}"
ENV_FILE="${SANDBOX_ENV_FILE}"
RUN_USER="\${FUNNY_RUN_USER:-$(id -un)}"
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
BUN="$(command -v bun)"

if [ -f "${INSTALLED_COMMIT_FILE}" ] && [ "$(cat "${INSTALLED_COMMIT_FILE}")" = "$FUNNY_COMMIT" ]; then
  echo "funny runner $FUNNY_COMMIT already installed"
  exit 0
fi

sudo mkdir -p "$INSTALL_DIR" "$(dirname "$ENV_FILE")"
sudo chown "$RUN_USER" "$INSTALL_DIR"
cd "$INSTALL_DIR"
[ -d .git ] || git init -q
git remote remove origin 2>/dev/null || true
git remote add origin "$FUNNY_REPO_URL"
git fetch -q --depth 1 origin "$FUNNY_COMMIT"
git checkout -q --force --detach FETCH_HEAD
bun install --frozen-lockfile >/tmp/funny-bun-install.log 2>&1 || bun install >/tmp/funny-bun-install.log 2>&1

# git's credential helper (\`gh auth git-credential\`) and pull requests need the GitHub CLI.
# Bounded, and never fatal: a base image without apt keeps its own gh, or none.
if ! command -v gh >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1; then
  timeout 180 sh -c '
    sudo mkdir -p -m 755 /etc/apt/keyrings &&
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null &&
    sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg &&
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null &&
    sudo apt-get update -qq && sudo apt-get install -y -qq gh
  ' >/tmp/funny-gh-install.log 2>&1 || echo "GitHub CLI install failed, see /tmp/funny-gh-install.log"
fi

if [ "\${FUNNY_BUILD_NATIVE:-}" = "1" ]; then
  if ! command -v cargo >/dev/null 2>&1 && [ ! -x "$HOME/.cargo/bin/cargo" ]; then
    timeout 120 sh -c "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal" >/tmp/funny-rustup.log 2>&1 || true
  fi
  # Bounded so a slow compile never pushes the whole install past the
  # provider's exec cap (InstaBox: 10 min), which would lose the template.
  if PATH="$HOME/.cargo/bin:$PATH" timeout 360 bun run build:native >/tmp/funny-native-git.log 2>&1; then
    # The build regenerates tracked bindings; keep the checkout at the commit.
    git checkout -q -- packages/native-git/index.js packages/native-git/index.d.ts
  else
    echo "native-git build failed (blame unavailable), see /tmp/funny-native-git.log"
  fi
fi

sudo tee /etc/systemd/system/${RUNNER_SERVICE} >/dev/null <<UNIT
[Unit]
Description=funny sandbox runner
After=network-online.target
Wants=network-online.target
ConditionPathExists=$ENV_FILE

[Service]
User=$RUN_USER
WorkingDirectory=$INSTALL_DIR/packages/runtime
EnvironmentFile=$ENV_FILE
Environment=HOME=$RUN_HOME
Environment=FUNNY_DATA_DIR=$RUN_HOME/.funny-runner
ExecStart=$BUN src/index.ts
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable ${RUNNER_SERVICE} >/dev/null 2>&1
echo "$FUNNY_COMMIT" > "${INSTALLED_COMMIT_FILE}"
echo "funny runner $FUNNY_COMMIT installed"
`;

/**
 * Environment the install script needs for `build`. `buildNative` compiles
 * native-git too: worth it once per template, too slow for an on-the-fly install.
 */
export function runnerInstallEnv(
  build: RunnerBuild,
  options: { buildNative?: boolean } = {},
): Record<string, string> {
  return {
    FUNNY_REPO_URL: build.repoUrl,
    FUNNY_COMMIT: build.commit,
    ...(options.buildNative ? { FUNNY_BUILD_NATIVE: '1' } : {}),
  };
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** One shell command that writes `script` to a temp file and runs it with `env`. */
export function scriptCommand(script: string, env: Record<string, string>): string {
  const assignments = Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(' ');
  return [
    `cat > /tmp/funny-install-runner.sh <<'FUNNY_INSTALL_EOF'`,
    script,
    'FUNNY_INSTALL_EOF',
    `${assignments} bash /tmp/funny-install-runner.sh`,
  ].join('\n');
}

/** Install `build` on the fly in a sandbox started from the provider's base image. */
export function runnerInstallCommand(build: RunnerBuild): string {
  return scriptCommand(RUNNER_INSTALL_SCRIPT, runnerInstallEnv(build));
}

/**
 * The per-sandbox runner env file. Values are restricted to URL/token
 * characters so no quoting or escaping is needed in systemd's EnvironmentFile
 * format; anything else is refused.
 */
export function runnerEnvFile(env: Record<string, string>): Result<string, string> {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) return err(`invalid env key ${key}`);
    if (!/^[A-Za-z0-9._:/@%+=,~-]+$/.test(value)) return err(`unsafe env value for ${key}`);
    lines.push(`${key}=${value}`);
  }
  return ok(lines.join('\n'));
}

const RESTART_RUNNER = `sudo systemctl restart ${RUNNER_SERVICE}`;

/** Write the env file (root-only) from inside the command, then (re)start the runner. */
const inlineStart = (envFile: string) =>
  [
    'sudo install -d -m 700 /etc/funny',
    `sudo tee ${SANDBOX_ENV_FILE} >/dev/null <<'FUNNY_ENV_EOF'`,
    envFile,
    'FUNNY_ENV_EOF',
    `sudo chmod 600 ${SANDBOX_ENV_FILE}`,
    RESTART_RUNNER,
  ].join('\n');

/** Move an uploaded env file into place (root-only), remove the upload, then (re)start the runner. */
const stagedStart = (staged: string) =>
  [
    'sudo install -d -m 700 /etc/funny',
    `sudo install -m 600 -o root -g root ${shellQuote(staged)} ${SANDBOX_ENV_FILE}; moved=$?`,
    `rm -f ${shellQuote(staged)}`,
    '[ "$moved" -eq 0 ] || exit "$moved"',
    RESTART_RUNNER,
  ].join('\n');

/** Write the per-sandbox runner env and (re)start the runner, in one command. */
export function startRunnerCommand(env: Record<string, string>): Result<string, string> {
  return runnerEnvFile(env).map(inlineStart);
}

/**
 * The command that starts the runner with `envFile`. A provider that writes
 * files gets the env file (tokens included) outside any command, since a
 * provider may keep its commands (Boat does): it lands in the sandbox user's
 * home and the command only moves it into place. Otherwise the command carries it.
 */
export function runnerStartCommand(
  provider: SandboxProvider,
  handle: SandboxHandle,
  envFile: string,
): ResultAsync<string, SandboxError> {
  const writeFile = provider.writeFile?.bind(provider);
  if (!writeFile) return okAsync(inlineStart(envFile));
  return provider
    .exec(handle, 'printf %s "$HOME"')
    .andThen((run) => {
      const home = run.stdout.trim();
      return run.exitCode === 0 && home.startsWith('/')
        ? okAsync(home)
        : errAsync<string, SandboxError>({
            kind: 'provider',
            message: 'cannot read the sandbox home',
          });
    })
    .andThen((home) => {
      const staged = `${home}/.funny-runner-env-${randomUUID()}`;
      return writeFile(handle, staged, `${envFile}\n`).map(() => stagedStart(staged));
    });
}
