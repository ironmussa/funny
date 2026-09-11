# Railway deployment and runner tools

## Service layout

Deploy from the repository root. Keep the central server and runner as separate services:

| Service | Config file           | Start command                        | Role                                                                            |
| ------- | --------------------- | ------------------------------------ | ------------------------------------------------------------------------------- |
| Server  | `railway.json`        | `bun run start:railway`              | UI, authentication, persistence, runner coordination; healthcheck `/api/health` |
| Runner  | `railway.runner.json` | `sh scripts/start-railway-runner.sh` | Agent commands, terminals, Git, and project files                               |

Both configs build with `bun run build`. Set the runner service's Railway Config File to `/railway.runner.json`. Attach a persistent volume at `/data` and set `FUNNY_DATA_DIR=/data`, `TEAM_SERVER_URL` to the central server URL, and `WS_TUNNEL_ONLY=true`. Configure `RUNNER_GRPC_ENDPOINT` and its TLS settings on the runner, and enable the dedicated gRPC listener on the server as described in the runbook; `TEAM_SERVER_URL` alone is insufficient. Approve the first device-link code in **Settings > Runners**. Credentials are stored at `$FUNNY_DATA_DIR/runner-credentials.json`. See [the gRPC runbook](runner-grpc-runbook.md) for transport configuration and connectivity diagnosis and [INSTALL.md](../../INSTALL.md) for server authentication/database setup.

The current runner startup script prepares the volume and, when launched as root, drops privileges to the `funny` user with `HOME=/data/home/funny`. With a custom `FUNNY_DATA_DIR`, the home is under that directory instead. An image that already starts as a non-root user retains its configured home: check it before relying on persistence.

## Installing OpenSpec or another npm CLI

A thread's directory is the user's project or scratch workspace, not Funny's source tree. A directory containing only `.git` has no application yet, but this says nothing about whether Node/npm are installed on the runner. Global CLI installation does **not** require `package.json` or `npm init`.

Run these checks in the affected Funny terminal:

```sh
pwd
id
printf 'HOME=%s\n' "$HOME"
command -v node
command -v npm
node --version
npm --version
npm config get prefix
```

If `npm install -g` fails with `EACCES` under `/mise/installs/node/...`, npm is trying to write to the image's Node installation. Use a writable user prefix; do not retry with `sudo` or change ownership of `/mise`.

```sh
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global" --location=user
export PATH="$HOME/.npm-global/bin:$PATH"
npm install -g @fission-ai/openspec@latest
openspec --version
```

Run installation directly, without `| tail`: otherwise the pipeline can hide the installer's failure status. The version check confirms the executable is usable. If installation already succeeded in another command, use `"$HOME/.npm-global/bin/openspec" --version` to check it without depending on `PATH`.

For a reproducible setup, replace `latest` with a chosen version. Check the [OpenSpec installation requirements](https://github.com/Fission-AI/OpenSpec/blob/main/docs/installation.md) against the runner's Node version. The user-prefix approach follows [npm's EACCES guidance](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally/).

## Persistence and command discovery

With the standard startup script and a volume at `/data`, `$HOME/.npm-global` and the user npm config at `$HOME/.npmrc` persist. Files installed outside the mounted volume are not a persistent tool installation. Replacing/removing the volume also removes its tools and state.

The `export PATH=...` above affects only that shell and its children. For future login shells, add this line once to `$HOME/.profile` (or the startup file your shell actually reads):

```sh
export PATH="$HOME/.npm-global/bin:$PATH"
```

Agents may execute each command in a fresh non-login shell, and running agents do not inherit later changes to a terminal's environment. Use the absolute executable path or include the PATH export in each agent command. A profile entry alone does not configure every provider process. The current Railway startup script does not add `.npm-global/bin` to the runner-wide PATH.

Installing the CLI and initializing a project are separate actions. Only run `openspec init` in the intended project when project initialization is requested; do not create an npm application merely to install OpenSpec.

## OpenSpec init: no tools detected

`No tools detected and no --tools flag provided` means initialization needs an explicit integration selection. It does not mean the OpenSpec installation failed or that the agent is unavailable. In a new project, tool configuration directories may not exist yet.

For a project using the Claude Code provider, initialize from the intended project root:

```sh
openspec init --tools claude
```

Select the actual coding tool, not just the model name: an Opus model can also run through other providers. For multiple integrations, use a comma-separated list such as `--tools claude,cursor`. Consult `openspec init --help` for the installed version's supported IDs. See the [OpenSpec CLI reference](https://github.com/Fission-AI/OpenSpec/blob/main/docs/cli.md).

If initialization already succeeded, verify the result instead of repeating it:

```sh
test -f openspec/config.yaml
ls -la openspec .claude
```

Inspect the generated skills/commands; their count depends on the installed version, profile, and delivery settings. Do not promise a fixed number. Generating `.claude` files does not prove an already-running Funny agent has loaded them; check discovery in that provider/session before claiming a slash command is available.

## mise warnings about /mise/migrations

`[WARN] migrate: failed create_dir_all: /mise/migrations` reports a failed directory creation in mise's state directory. It is separate from OpenSpec's tool-selection error and is consistent with the non-root runner being unable to write to the image's `/mise` directory.

Do not describe this as universally harmless: a successful OpenSpec initialization only shows it did not block that operation. It can still indicate a problem with mise state or future tool management. Collect these checks in the affected shell:

```sh
id
printf 'MISE_DATA_DIR=%s\n' "${MISE_DATA_DIR:-<unset>}"
ls -ld /mise /mise/migrations
command -v mise
command -v node
node --version
npm --version
openspec --version
```

A missing `/mise/migrations` entry is useful diagnostic output. Record each command's exit status when diagnosing a failure. Do not use sudo, recursively change `/mise` ownership, or hide warnings as a fix. Changing `MISE_DATA_DIR` without checking the image's existing Node installation and shims may affect tool resolution; review the runner image/environment before choosing a writable mise layout. The npm user-prefix workaround does not repair mise's state directory.

## Notes for agents working inside the runner

This repository's documentation is not automatically present in an empty user project. If needed, copy the following guidance into that project's agent instructions:

> Commands execute on a Railway runner as a non-root user. Check `command -v npm` and `npm --version` rather than inferring npm availability from `package.json`. For global npm tools use `$HOME/.npm-global` and include its `bin` directory in PATH, or invoke the executable by absolute path. Do not use sudo. Check HOME is on the persistent volume before assuming installs survive redeployment. Run installers without a pipeline that hides their exit status and verify the installed CLI. Initialize project files only when requested.
