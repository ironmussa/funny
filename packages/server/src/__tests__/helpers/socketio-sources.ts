import { readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';

/** Concatenate socketio bootstrap + all modules under services/socketio/. */
export function readSocketioImplementationSources(): string {
  const servicesDir = resolve(import.meta.dir, '../../services');
  const socketioDir = join(servicesDir, 'socketio');
  const moduleSources = readdirSync(socketioDir)
    .filter((name) => name.endsWith('.ts'))
    .sort()
    .map((name) => readFileSync(join(socketioDir, name), 'utf-8'));
  return [readFileSync(join(servicesDir, 'socketio.ts'), 'utf-8'), ...moduleSources].join('\n');
}
