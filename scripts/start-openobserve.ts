import { execFileSync } from 'child_process';
import { mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const home = homedir();
const bin = join(home, '.funny/openobserve/openobserve.exe');
const dataDir = join(home, '.funny/openobserve/data');

if (!existsSync(bin)) {
  console.error(`ERROR: OpenObserve binary not found at ${bin}`);
  console.error('Download it from: https://openobserve.ai/downloads');
  process.exit(1);
}

mkdirSync(dataDir, { recursive: true });

console.info('Starting OpenObserve...');
console.info(`  Data:  ${dataDir}`);
console.info('  UI:    http://localhost:5080/web/');
console.info('  OTLP:  http://localhost:5080/api/default/');
console.info('  Login: root@example.com / Complexpass#123');
console.info('');
console.info('Press Ctrl+C to stop.');
console.info('');

execFileSync(bin, [], {
  stdio: 'inherit',
  env: {
    ...process.env,
    ZO_ROOT_USER_EMAIL: 'root@example.com',
    ZO_ROOT_USER_PASSWORD: 'Complexpass#123',
    ZO_DATA_DIR: dataDir,
  },
});
