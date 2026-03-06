import { ensurePodmanReady, run } from './ensure-podman.mjs';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: bun scripts/podman.mjs <podman args...>');
  process.exit(1);
}

ensurePodmanReady();
process.exit(run('podman', args).status);
