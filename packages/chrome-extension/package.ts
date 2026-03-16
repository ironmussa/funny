/**
 * Packages the Chrome extension into a .zip file for distribution.
 *
 * Includes only the runtime files needed by Chrome — no source code,
 * node_modules, or build tooling.
 */

import { existsSync, readFileSync, mkdirSync, cpSync, rmSync } from 'fs';
import { join } from 'path';

const ROOT = import.meta.dir;
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf-8'));
const version = manifest.version || '0.0.0';
const zipName = `funny-annotator-v${version}.zip`;
const zipPath = join(ROOT, zipName);

// Files to include in the zip
const files = [
  'manifest.json',
  'background.js',
  'content.js',
  'content.css',
  'page-bridge.js',
  'popup.html',
  'popup.js',
  'icons/icon16.png',
  'icons/icon48.png',
  'icons/icon128.png',
];

// Verify all files exist
const missing = files.filter((f) => !existsSync(join(ROOT, f)));
if (missing.length > 0) {
  console.error(`Missing files: ${missing.join(', ')}`);
  console.error('Run "bun run build" first.');
  process.exit(1);
}

// Create a temp staging directory, copy files, then zip
const staging = join(ROOT, '.package-staging');
if (existsSync(staging)) rmSync(staging, { recursive: true });
mkdirSync(staging, { recursive: true });
mkdirSync(join(staging, 'icons'), { recursive: true });

for (const file of files) {
  cpSync(join(ROOT, file), join(staging, file));
}

// Remove old zip if exists
if (existsSync(zipPath)) rmSync(zipPath);

// Use PowerShell to create the zip
const stagingWin = staging.replace(/\//g, '\\');
const zipPathWin = zipPath.replace(/\//g, '\\');
const psCmd = `Compress-Archive -Path '${stagingWin}\\*' -DestinationPath '${zipPathWin}'`;

const proc = Bun.spawnSync(['powershell', '-Command', psCmd], {
  cwd: ROOT,
  stdout: 'inherit',
  stderr: 'inherit',
});

// Clean up staging
rmSync(staging, { recursive: true });

if (proc.exitCode !== 0) {
  console.error('Failed to create zip.');
  process.exit(1);
}

console.info(`\nPackaged: ${zipName}`);
console.info(`Upload this file to the Chrome Web Store or share with testers.`);
