import { platform } from 'os';

import * as pty from 'node-pty';

const shell = platform() === 'win32' ? 'powershell.exe' : 'bash';

console.info(`Spawning ${shell}...`);

const ptyProcess = pty.spawn(shell, [], {
  name: 'xterm-color',
  cols: 80,
  rows: 30,
  cwd: process.cwd(),
  env: process.env as any,
  useConpty: false,
});

ptyProcess.onData((data) => {
  console.info(`[PTY DATA]: ${JSON.stringify(data)}`);
});

ptyProcess.onExit((res) => {
  console.info(`[PTY EXIT]: ${JSON.stringify(res)}`);
});

// Wait for shell to start
setTimeout(async () => {
  console.info('PTY keys:', Object.keys(ptyProcess));
  try {
    console.info('Writing "ls" to PTY via fs.writeSync...');
    // @ts-ignore
    const fd = ptyProcess._fd;
    if (typeof fd === 'number') {
      const fs = await import('fs');
      fs.writeSync(fd, 'ls\r');
    } else {
      console.info('No _fd found, trying standard write');
      ptyProcess.write('ls\r');
    }
  } catch (e) {
    console.error('Write failed:', e);
  }
}, 2000);

setTimeout(() => {
  console.info('Exiting...');
  ptyProcess.kill();
}, 5000);
