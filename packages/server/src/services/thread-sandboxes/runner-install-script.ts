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

import { err, ok, type Result } from 'neverthrow';

import type { RunnerBuild } from './runner-build.js';

export const SANDBOX_INSTALL_DIR = '/opt/funny';
export const SANDBOX_ENV_FILE = '/etc/funny/sandbox.env';
export const RUNNER_SERVICE = 'funny-runner.service';
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

/** Environment the install script needs for `build`. */
export function runnerInstallEnv(build: RunnerBuild): Record<string, string> {
  return { FUNNY_REPO_URL: build.repoUrl, FUNNY_COMMIT: build.commit };
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
 * Write the per-sandbox runner env (root-only) and (re)start the runner. Values
 * are restricted to URL/token characters so no quoting or escaping is needed in
 * systemd's EnvironmentFile format; anything else is refused.
 */
export function startRunnerCommand(env: Record<string, string>): Result<string, string> {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) return err(`invalid env key ${key}`);
    if (!/^[A-Za-z0-9._:/@%+=,~-]+$/.test(value)) return err(`unsafe env value for ${key}`);
    lines.push(`${key}=${value}`);
  }
  return ok(
    [
      'sudo install -d -m 700 /etc/funny',
      `sudo tee ${SANDBOX_ENV_FILE} >/dev/null <<'FUNNY_ENV_EOF'`,
      ...lines,
      'FUNNY_ENV_EOF',
      `sudo chmod 600 ${SANDBOX_ENV_FILE}`,
      `sudo systemctl restart ${RUNNER_SERVICE}`,
    ].join('\n'),
  );
}
