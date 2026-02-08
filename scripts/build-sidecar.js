#!/usr/bin/env node

// Builds the server as a standalone Bun binary with the correct target triple name
// for Tauri sidecar bundling.

const { execSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

function getTargetTriple() {
  const platform = os.platform();
  const arch = os.arch();

  const archMap = { x64: 'x86_64', arm64: 'aarch64' };
  const rustArch = archMap[arch] || arch;

  switch (platform) {
    case 'win32':
      return `${rustArch}-pc-windows-msvc`;
    case 'darwin':
      return `${rustArch}-apple-darwin`;
    case 'linux':
      return `${rustArch}-unknown-linux-gnu`;
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}

const triple = process.env.TAURI_TARGET_TRIPLE || getTargetTriple();
const ext = os.platform() === 'win32' ? '.exe' : '';
const outDir = path.join(__dirname, '..', 'src-tauri', 'binaries');
const outFile = path.join(outDir, `a-parallel-server-${triple}${ext}`);

fs.mkdirSync(outDir, { recursive: true });

console.log(`Building sidecar for ${triple}...`);
console.log(`Output: ${outFile}`);

execSync(
  `bun build --compile packages/server/src/index.ts --outfile "${outFile}"`,
  { stdio: 'inherit', cwd: path.join(__dirname, '..') }
);

console.log('Sidecar built successfully.');
