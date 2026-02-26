#!/usr/bin/env bun

// Builds the server as a standalone Bun binary with the correct target triple name
// for Tauri sidecar bundling.

import { execSync } from 'child_process';
import { mkdirSync } from 'fs';
import { platform, arch } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function getTargetTriple(): string {
  const p = platform();
  const a = arch();

  const archMap: Record<string, string> = { x64: 'x86_64', arm64: 'aarch64' };
  const rustArch = archMap[a] || a;

  switch (p) {
    case 'win32':
      return `${rustArch}-pc-windows-msvc`;
    case 'darwin':
      return `${rustArch}-apple-darwin`;
    case 'linux':
      return `${rustArch}-unknown-linux-gnu`;
    default:
      throw new Error(`Unsupported platform: ${p}`);
  }
}

const triple = process.env.TAURI_TARGET_TRIPLE || getTargetTriple();
const ext = platform() === 'win32' ? '.exe' : '';
const outDir = join(__dirname, '..', 'src-tauri', 'binaries');
const outFile = join(outDir, `funny-server-${triple}${ext}`);

mkdirSync(outDir, { recursive: true });

console.log(`Building sidecar for ${triple}...`);
console.log(`Output: ${outFile}`);

execSync(`bun build --compile packages/server/src/index.ts --outfile "${outFile}"`, {
  stdio: 'inherit',
  cwd: join(__dirname, '..'),
});

console.log('Sidecar built successfully.');
