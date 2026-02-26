/**
 * Pre-startup script: kills any process holding the server port.
 * Prevents ghost processes from causing dual-listener issues.
 *
 * On Windows, when a process dies but its children inherited the server's
 * listening socket handle, the TCP entry persists as a "ghost" — netstat
 * reports the dead PID, and the port remains occupied. This script handles
 * that case by finding and killing processes that hold inherited handles.
 */
const port = Number(process.argv[2]) || Number(process.env.PORT) || 3001;
const host = process.env.HOST || '127.0.0.1';
const isWindows = process.platform === 'win32';

function findListeningPids(targetPort: number): number[] {
  try {
    if (isWindows) {
      const result = Bun.spawnSync([
        'cmd',
        '/c',
        `netstat -ano | findstr :${targetPort} | findstr LISTENING`,
      ]);
      const output = result.stdout.toString().trim();
      if (!output) return [];
      const pids = new Set<number>();
      for (const line of output.split('\n')) {
        const parts = line.trim().split(/\s+/);
        const localAddr = parts[1] ?? '';
        const addrPort = localAddr.split(':').pop();
        if (addrPort !== String(targetPort)) continue;
        const pid = parseInt(parts[parts.length - 1], 10);
        if (pid && pid !== process.pid) pids.add(pid);
      }
      return [...pids];
    } else {
      const result = Bun.spawnSync(['lsof', '-ti', `:${targetPort}`]);
      const output = result.stdout.toString().trim();
      if (!output) return [];
      return output
        .split('\n')
        .map((s) => parseInt(s, 10))
        .filter((p) => p && p !== process.pid);
    }
  } catch {
    return [];
  }
}

/** Find ALL PIDs with any TCP connection (LISTENING, ESTABLISHED, etc.) on the port */
function findAllPortPids(targetPort: number): number[] {
  try {
    const result = Bun.spawnSync(['cmd', '/c', `netstat -ano | findstr :${targetPort}`]);
    const output = result.stdout.toString().trim();
    if (!output) return [];
    const pids = new Set<number>();
    for (const line of output.split('\n')) {
      const parts = line.trim().split(/\s+/);
      // Check both local and remote addresses for exact port match
      for (const addr of [parts[1], parts[2]]) {
        if (addr?.split(':').pop() === String(targetPort)) {
          const pid = parseInt(parts[parts.length - 1], 10);
          if (pid && pid !== process.pid) pids.add(pid);
          break;
        }
      }
    }
    return [...pids];
  } catch {
    return [];
  }
}

function pidExists(pid: number): boolean {
  try {
    const r = Bun.spawnSync(['cmd', '/c', `tasklist /FI "PID eq ${pid}" /NH`]);
    const out = r.stdout.toString().trim();
    return !out.includes('No tasks') && out.includes(String(pid));
  } catch {
    return false;
  }
}

async function isPortBindable(targetPort: number, hostname: string): Promise<boolean> {
  try {
    const testServer = Bun.serve({
      port: targetPort,
      hostname,
      reusePort: false,
      fetch() {
        return new Response('');
      },
    });
    testServer.stop(true);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find processes that might hold inherited socket handles from a ghost PID.
 * On Windows, child processes inherit all handles from their parent at
 * CreateProcess time. When the parent dies, children keep those handles alive.
 *
 * Strategy: find all living processes that have ANY TCP connection to the port
 * (excluding our own PID and its parent chain). These are suspects.
 */
function findGhostHandleHolders(targetPort: number): number[] {
  const allPortPids = findAllPortPids(targetPort);
  const suspects: number[] = [];

  // Build our parent chain (don't kill ourselves or our ancestors)
  const safeChain = new Set<number>([process.pid]);
  try {
    const r = Bun.spawnSync([
      'powershell',
      '-NoProfile',
      '-Command',
      `$p = ${process.pid}; while ($p -gt 0) { $p; $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue; if (-not $proc) { break }; $p = $proc.ParentProcessId }`,
    ]);
    for (const line of r.stdout.toString().trim().split('\n')) {
      const pid = parseInt(line.trim(), 10);
      if (pid) safeChain.add(pid);
    }
  } catch {}

  for (const pid of allPortPids) {
    if (safeChain.has(pid)) continue;
    if (pidExists(pid)) {
      suspects.push(pid);
    }
  }

  return suspects;
}

async function killPort(targetPort: number): Promise<void> {
  // Fast path: try binding first
  if (await isPortBindable(targetPort, host)) {
    console.log(`[kill-port] Port ${targetPort} is free`);
    return;
  }

  const pids = findListeningPids(targetPort);

  // Kill live PIDs
  const ghostPids: number[] = [];
  for (const pid of pids) {
    if (isWindows && !pidExists(pid)) {
      ghostPids.push(pid);
      console.log(`[kill-port] PID ${pid} on port ${targetPort} is dead (ghost socket)`);
      continue;
    }
    console.log(`[kill-port] Killing PID ${pid} on port ${targetPort}`);
    if (isWindows) {
      Bun.spawnSync(['cmd', '/c', `taskkill /F /T /PID ${pid}`]);
    } else {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  }

  // On Windows, if we found ghost PIDs, hunt for processes holding inherited handles
  if (isWindows && ghostPids.length > 0) {
    console.log(`[kill-port] Ghost sockets detected — searching for inherited handle holders...`);
    const suspects = findGhostHandleHolders(targetPort);
    if (suspects.length > 0) {
      console.log(
        `[kill-port] Found ${suspects.length} suspect process(es): ${suspects.join(', ')}`,
      );
      for (const pid of suspects) {
        console.log(`[kill-port] Killing suspect PID ${pid}`);
        Bun.spawnSync(['cmd', '/c', `taskkill /F /T /PID ${pid}`]);
      }
    }
  }

  // Wait until port is actually bindable (up to 10s)
  for (let i = 0; i < 20; i++) {
    await Bun.sleep(500);
    if (await isPortBindable(targetPort, host)) {
      console.log(`[kill-port] Port ${targetPort} is free`);
      return;
    }
    // Retry kill every 2s
    if (isWindows && i > 0 && i % 4 === 0) {
      const remaining = findListeningPids(targetPort);
      for (const pid of remaining) {
        if (!pidExists(pid)) continue;
        console.log(`[kill-port] Retrying kill for PID ${pid}`);
        Bun.spawnSync(['cmd', '/c', `taskkill /F /T /PID ${pid}`]);
      }
    }
  }

  // Last resort on Windows: PowerShell to find and kill by connection
  if (isWindows) {
    console.log(`[kill-port] Trying PowerShell to free port ${targetPort}...`);
    Bun.spawnSync([
      'powershell',
      '-NoProfile',
      '-Command',
      `Get-NetTCPConnection -LocalPort ${targetPort} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`,
    ]);
    for (let i = 0; i < 6; i++) {
      await Bun.sleep(500);
      if (await isPortBindable(targetPort, host)) {
        console.log(`[kill-port] Port ${targetPort} is free (via PowerShell)`);
        return;
      }
    }
  }

  console.warn(
    `[kill-port] Port ${targetPort} may still be in use — server will attempt reusePort`,
  );
}

await killPort(port);

export {};
