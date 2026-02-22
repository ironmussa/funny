/**
 * Pre-startup script: kills any process holding the server port.
 * Prevents ghost processes from causing dual-listener issues.
 * Runs before `bun --watch` starts the server.
 */
const port = Number(process.argv[2]) || Number(process.env.PORT) || 3001;
const host = process.env.HOST || '127.0.0.1';

function findListeningPids(targetPort: number): number[] {
  const isWindows = process.platform === 'win32';
  try {
    if (isWindows) {
      // Use exact port match to avoid false positives (e.g. :3001 matching :30010)
      const result = Bun.spawnSync(['cmd', '/c', `netstat -ano | findstr :${targetPort} | findstr LISTENING`]);
      const output = result.stdout.toString().trim();
      if (!output) return [];
      const pids = new Set<number>();
      for (const line of output.split('\n')) {
        const parts = line.trim().split(/\s+/);
        // Verify the port matches exactly (local address is parts[1], e.g. "127.0.0.1:3007")
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
      return output.split('\n').map(s => parseInt(s, 10)).filter(p => p && p !== process.pid);
    }
  } catch {
    return [];
  }
}

/** Check if a Windows PID actually exists (not just a ghost in netstat) */
function pidExists(pid: number): boolean {
  try {
    const r = Bun.spawnSync(['cmd', '/c', `tasklist /FI "PID eq ${pid}" /NH`]);
    const out = r.stdout.toString().trim();
    // tasklist returns "INFO: No tasks are running..." when PID doesn't exist
    return !out.includes('No tasks') && out.includes(String(pid));
  } catch {
    return false;
  }
}

/**
 * Try to actually bind a TCP socket to the port. This is more reliable than
 * netstat because it tests whether the OS will actually allow us to listen.
 * netstat can show ghost LISTENING entries after a process dies on Windows.
 */
async function isPortBindable(targetPort: number, hostname: string): Promise<boolean> {
  try {
    const testServer = Bun.serve({
      port: targetPort,
      hostname,
      reusePort: false, // Strict check — fail if anything else is listening
      fetch() { return new Response(''); },
    });
    testServer.stop(true);
    return true;
  } catch {
    return false;
  }
}

async function killPort(targetPort: number): Promise<void> {
  const isWindows = process.platform === 'win32';

  // Fast path: try binding first — avoids unnecessary netstat/kill dance
  if (await isPortBindable(targetPort, host)) {
    console.log(`[kill-port] Port ${targetPort} is free`);
    return;
  }

  const pids = findListeningPids(targetPort);
  if (pids.length === 0) {
    // netstat shows nothing but bind failed — OS-level socket lingering
    console.log(`[kill-port] Port ${targetPort} has lingering socket, waiting for OS cleanup...`);
  } else {
    // Kill only PIDs that actually exist (skip ghosts)
    let allGhosts = true;
    for (const pid of pids) {
      if (isWindows && !pidExists(pid)) {
        console.log(`[kill-port] PID ${pid} on port ${targetPort} is already dead (ghost socket)`);
        continue;
      }
      allGhosts = false;
      console.log(`[kill-port] Killing PID ${pid} on port ${targetPort}`);
      if (isWindows) {
        const r = Bun.spawnSync(['cmd', '/c', `taskkill /F /T /PID ${pid}`]);
        const out = r.stdout.toString().trim();
        const err = r.stderr.toString().trim();
        if (out) console.log(`[kill-port]   ${out}`);
        if (err) console.log(`[kill-port]   ${err}`);
      } else {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
    }
    if (allGhosts) {
      console.log(`[kill-port] All PIDs are ghosts — waiting for OS to release port ${targetPort}...`);
    }
  }

  // Wait until port is actually bindable (up to 15s).
  // Use a real bind test, not netstat — netstat lies about ghost sockets on Windows.
  for (let i = 0; i < 30; i++) {
    await Bun.sleep(500);
    if (await isPortBindable(targetPort, host)) {
      console.log(`[kill-port] Port ${targetPort} is free`);
      return;
    }
    // On Windows, retry kill for any live PIDs every 2s (skip ghosts)
    if (isWindows && i > 0 && i % 4 === 0) {
      const remaining = findListeningPids(targetPort);
      for (const pid of remaining) {
        if (!pidExists(pid)) continue;
        console.log(`[kill-port] Retrying kill for PID ${pid}`);
        Bun.spawnSync(['cmd', '/c', `taskkill /F /T /PID ${pid}`]);
      }
    }
  }

  // Last resort on Windows: kill by port using PowerShell
  if (isWindows) {
    console.log(`[kill-port] Trying PowerShell to free port ${targetPort}...`);
    Bun.spawnSync(['powershell', '-NoProfile', '-Command',
      `Get-NetTCPConnection -LocalPort ${targetPort} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`
    ]);
    // Wait a bit more after PowerShell
    for (let i = 0; i < 6; i++) {
      await Bun.sleep(500);
      if (await isPortBindable(targetPort, host)) {
        console.log(`[kill-port] Port ${targetPort} is free (via PowerShell)`);
        return;
      }
    }
  }

  console.warn(`[kill-port] Port ${targetPort} may still be in use — server will attempt reusePort`);
}

await killPort(port);

export {};
