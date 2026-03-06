import { ensurePodmanReady, run } from './ensure-podman.mjs';

const args = process.argv.slice(2);
ensurePodmanReady();
process.exit(run('podman-compose', args).status);
