import { selectClientRenderer } from '../packages/client-core/src/renderer-selection';

const renderer = selectClientRenderer(process.argv.slice(2));
const command =
  renderer === 'gpuix'
    ? ['bun', 'run', '--cwd', 'packages/client-gpuix', 'start']
    : ['bun', 'run', 'dev:client'];
const child = Bun.spawn({
  cmd: command,
  cwd: import.meta.dir + '/..',
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});
process.exitCode = await child.exited;
