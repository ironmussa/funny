import { platform } from 'os';
import { createInterface } from 'readline';

import * as pty from 'node-pty';

const isWindows = platform() === 'win32';
const activePtys = new Map();

// Input stream (stdin) - expect line-delimited JSON commands
const rl = createInterface({
  input: process.stdin,
  terminal: false,
});

rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    handleMessage(msg);
  } catch (err) {
    console.error('Failed to parse input:', err);
  }
});

function send(type, data) {
  console.log(JSON.stringify({ type, data }));
}

function handleMessage(msg) {
  const { type, ...args } = msg;

  switch (type) {
    case 'spawn':
      spawnPty(args.id, args.cwd, args.cols, args.rows, args.env, args.shell);
      break;
    case 'write':
      writePty(args.id, args.data);
      break;
    case 'resize':
      resizePty(args.id, args.cols, args.rows);
      break;
    case 'kill':
      killPty(args.id);
      break;
    default:
      console.error('Unknown message type:', type);
  }
}

/** Resolve the shell identifier to an executable path and args. */
function resolveShell(shellId) {
  const defaultShell = isWindows ? 'powershell.exe' : process.env.SHELL || 'bash';
  if (!shellId || shellId === 'default') {
    return { exe: defaultShell, args: [] };
  }

  switch (shellId) {
    case 'git-bash': {
      // Try common Git Bash locations.
      // Do NOT pass -i: the PTY already provides an interactive session,
      // and the double-interactive flag causes duplicate echo on Windows.
      const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
      return { exe: `${programFiles}\\Git\\bin\\bash.exe`, args: ['--login'] };
    }
    case 'powershell':
      return { exe: 'powershell.exe', args: [] };
    case 'pwsh':
      return { exe: 'pwsh.exe', args: [] };
    case 'cmd':
      return { exe: 'cmd.exe', args: [] };
    case 'wsl':
      return { exe: 'wsl.exe', args: [] };
    // POSIX shells — accept a small allowlist of well-known binary names.
    // The caller (pty-manager) has already validated against the detected-shells
    // allowlist; this switch is defense-in-depth.
    case 'bash':
    case 'zsh':
    case 'fish':
    case 'sh':
    case 'dash':
    case 'ksh':
    case 'tcsh':
    case 'csh':
    case 'nushell':
    case 'nu':
    case 'elvish':
      return { exe: shellId, args: [] };
    default:
      // Unknown id — never pass it through as an executable path. Fall back
      // to the system default rather than running an attacker-supplied binary.
      console.error(`[pty-helper] Unknown shell id "${shellId}" — using default`);
      return { exe: defaultShell, args: [] };
  }
}

function spawnPty(id, cwd, cols, rows, env, shellId) {
  if (activePtys.has(id)) return;

  try {
    const { exe: shell, args: shellArgs } = resolveShell(shellId);

    // Merge provided env with process.env
    const ptyEnv = { ...process.env, ...env };

    // On Windows, MSYS2/Git Bash has its own pseudo-console (pcon) layer that
    // conflicts with node-pty's ConPTY, causing double echo on both input and
    // output. Disable the MSYS2 pcon layer so ConPTY handles everything.
    if (isWindows && (shellId === 'git-bash' || shell.toLowerCase().includes('git'))) {
      const existing = ptyEnv.MSYS || '';
      if (!existing.includes('disable_pcon')) {
        ptyEnv.MSYS = existing ? `${existing} disable_pcon` : 'disable_pcon';
      }
    }

    const ptyProcess = pty.spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: cwd || process.cwd(),
      env: ptyEnv,
    });

    activePtys.set(id, ptyProcess);

    ptyProcess.onData((data) => {
      send('pty:data', { ptyId: id, data });
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      send('pty:exit', { ptyId: id, exitCode, signal });
      activePtys.delete(id);
    });
  } catch (err) {
    console.error(`Failed to spawn PTY ${id}:`, err);
    send('pty:error', { ptyId: id, error: err.message });
  }
}

function writePty(id, data) {
  const ptyProcess = activePtys.get(id);
  if (ptyProcess) {
    try {
      ptyProcess.write(data);
    } catch (err) {
      console.error(`Failed to write to PTY ${id}:`, err);
    }
  }
}

function resizePty(id, cols, rows) {
  const ptyProcess = activePtys.get(id);
  if (ptyProcess) {
    try {
      ptyProcess.resize(cols, rows);
    } catch (err) {
      console.error(`Failed to resize PTY ${id}:`, err);
    }
  }
}

function killPty(id) {
  const ptyProcess = activePtys.get(id);
  if (ptyProcess) {
    activePtys.delete(id);
    try {
      // On Windows, node-pty's kill() spawns conpty_console_list_agent.js which
      // can throw "AttachConsole failed" if the shell already exited. Kill the
      // underlying process directly first to avoid the noisy error.
      if (isWindows && ptyProcess.pid) {
        try {
          process.kill(ptyProcess.pid);
        } catch {
          // process may already be gone
        }
      }
      ptyProcess.kill();
    } catch {
      // ignore
    }
  }
}
