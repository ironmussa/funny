export function ensurePodmanReady() {
  if (process.platform !== 'win32') {
    return;
  }

  const inspect = run('podman', ['machine', 'list', '--format', 'json'], {
    capture: true,
    allowFailure: true,
  });

  if (!inspect.ok) {
    console.log('[podman-wrapper] `podman machine list` failed, trying to start the machine...');
    startMachine();
    return;
  }

  let machines;
  try {
    machines = JSON.parse(inspect.stdout || '[]');
  } catch {
    console.log('[podman-wrapper] Could not parse machine list, trying to start the machine...');
    startMachine();
    return;
  }

  const running = Array.isArray(machines) && machines.some((machine) => machine?.Running === true);
  if (!running) {
    console.log('[podman-wrapper] Podman machine is not running. Starting it now...');
    startMachine();
  }
}

export function run(command, args, options = {}) {
  const result = Bun.spawnSync({
    cmd: [command, ...args],
    cwd: options.cwd ?? process.cwd(),
    env: { ...process.env, ...(options.env ?? {}) },
    stdin: 'inherit',
    stdout: options.capture ? 'pipe' : 'inherit',
    stderr: options.capture ? 'pipe' : 'inherit',
  });

  const ok = result.exitCode === 0;
  if (!ok && !options.allowFailure) {
    process.exit(result.exitCode ?? 1);
  }

  return {
    ok,
    status: result.exitCode ?? 1,
    stdout: options.capture ? Buffer.from(result.stdout).toString('utf-8') : '',
    stderr: options.capture ? Buffer.from(result.stderr).toString('utf-8') : '',
  };
}

function startMachine() {
  const start = run('podman', ['machine', 'start'], { allowFailure: true });
  if (start.ok) {
    return;
  }

  console.log('[podman-wrapper] `podman machine start` failed. Trying `podman machine init` once...');
  const init = run('podman', ['machine', 'init'], { allowFailure: true });
  if (!init.ok) {
    console.error('[podman-wrapper] Unable to initialize Podman machine.');
    process.exit(init.status);
  }

  const retry = run('podman', ['machine', 'start'], { allowFailure: true });
  if (!retry.ok) {
    console.error('[podman-wrapper] Unable to start Podman machine.');
    process.exit(retry.status);
  }
}
