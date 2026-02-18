/**
 * Pre-startup script: kills any process holding the server port.
 * Prevents ghost processes from causing dual-listener issues.
 * Runs before `bun --watch` starts the server.
 */
const port = Number(process.argv[2]) || Number(process.env.PORT) || 3001;

function findListeningPids(targetPort: number): number[] {
  const isWindows = process.platform === 'win32';
  try {
    if (isWindows) {
      const result = Bun.spawnSync(['cmd', '/c', `netstat -ano | findstr :${targetPort} | findstr LISTENING`]);
      const output = result.stdout.toString().trim();
      if (!output) return [];
      const pids = new Set<number>();
      for (const line of output.split('\n')) {
        const parts = line.trim().split(/\s+/);
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

async function killPort(targetPort: number): Promise<void> {
  const isWindows = process.platform === 'win32';
  const pids = findListeningPids(targetPort);
  if (pids.length === 0) return;

  for (const pid of pids) {
    console.log(`[kill-port] Killing PID ${pid} on port ${targetPort}`);
    if (isWindows) {
      // /T = kill process tree (children too), /F = force
      Bun.spawnSync(['cmd', '/c', `taskkill /F /T /PID ${pid} 2>nul`]);
    } else {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  }

  // Wait until port is actually free (up to 10s)
  for (let i = 0; i < 20; i++) {
    await Bun.sleep(500);
    if (findListeningPids(targetPort).length === 0) {
      console.log(`[kill-port] Port ${targetPort} is free`);
      return;
    }
  }
  console.warn(`[kill-port] Port ${targetPort} may still be in use`);
}

await killPort(port);

export {};
