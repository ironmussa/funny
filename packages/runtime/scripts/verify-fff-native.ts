#!/usr/bin/env bun

import { existsSync } from 'node:fs';

import { FileFinder, findBinary, getNpmPackageName, getTriple } from '@ff-labs/fff-node';

const RELEASE_PACKAGES = {
  'x86_64-pc-windows-msvc': '@ff-labs/fff-bin-win32-x64',
  'x86_64-unknown-linux-gnu': '@ff-labs/fff-bin-linux-x64-gnu',
  'aarch64-apple-darwin': '@ff-labs/fff-bin-darwin-arm64',
  'x86_64-apple-darwin': '@ff-labs/fff-bin-darwin-x64',
} as const;

type ReleaseTarget = keyof typeof RELEASE_PACKAGES;

function fail(message: string): never {
  console.error(`[fff-native-release-gate] ${message}`);
  process.exit(1);
}

const expectedTarget = process.argv[2];
if (!expectedTarget) fail('Expected a release target argument.');

if (!(expectedTarget in RELEASE_PACKAGES)) {
  fail(`Unsupported release target: ${expectedTarget}`);
}

const target = expectedTarget as ReleaseTarget;
const hostTarget = getTriple();
if (hostTarget !== target) {
  fail(`Release target ${target} cannot be verified on host ${hostTarget}.`);
}

const expectedPackage = RELEASE_PACKAGES[target];
const resolvedPackage = getNpmPackageName();
if (resolvedPackage !== expectedPackage) {
  fail(`Expected ${expectedPackage} for ${target}, resolved ${resolvedPackage}.`);
}

const binaryPath = findBinary();
if (!binaryPath || !existsSync(binaryPath)) {
  fail(`Native library from ${expectedPackage} is not installed.`);
}

try {
  FileFinder.ensureLoaded();
} catch (error) {
  fail(
    `Native library could not be loaded: ${error instanceof Error ? error.message : 'unknown error'}`,
  );
}

const health = FileFinder.healthCheckStatic();
if (!health.ok || !health.value.version) {
  fail(`Native health check failed for ${target}.`);
}

console.info(
  `[fff-native-release-gate] ${target}: ${expectedPackage} loaded (FFF ${health.value.version}).`,
);
