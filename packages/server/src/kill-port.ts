/**
 * Pre-startup script: kills any process holding the server port.
 * Prevents ghost processes from causing dual-listener issues.
 * Runs before `bun --watch` starts the server.
 */
const port = Number(process.env.PORT) || 3001;

async function killPort(port: number): Promise<void> {
  const isWindows = process.platform === 'win32';

  try {
    if (isWindows) {
      // netstat to find PIDs listening on the port
      const result = Bun.spawnSync(['cmd', '/c', `netstat -ano | findstr :${port} | findstr LISTENING`]);
      const output = result.stdout.toString();
      if (!output.trim()) return;

      const pids = new Set<number>();
      for (const line of output.trim().split('\n')) {
        const parts = line.trim().split(/\s+/);
        const pid = parseInt(parts[parts.length - 1], 10);
        if (pid && pid !== process.pid) pids.add(pid);
      }

      for (const pid of pids) {
        console.log(`[kill-port] Killing PID ${pid} on port ${port}`);
        Bun.spawnSync(['cmd', '/c', `taskkill /F /PID ${pid}`]);
      }
    } else {
      // Unix: use lsof
      const result = Bun.spawnSync(['lsof', '-ti', `:${port}`]);
      const output = result.stdout.toString().trim();
      if (!output) return;

      for (const pidStr of output.split('\n')) {
        const pid = parseInt(pidStr, 10);
        if (pid && pid !== process.pid) {
          console.log(`[kill-port] Killing PID ${pid} on port ${port}`);
          process.kill(pid, 'SIGTERM');
        }
      }
    }
  } catch (e) {
    // Best-effort — if we can't kill, the server will fail with EADDRINUSE which is informative
    console.warn(`[kill-port] Could not clean port ${port}:`, e);
  }
}

await killPort(port);
