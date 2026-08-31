import { hasNativeTestRenderer } from '@gpuix/react/testing';

const expectedNativeHost = process.platform === 'darwin' || process.platform === 'win32';

if (!expectedNativeHost) {
  process.stdout.write(`Native GPUIX test renderer is optional on ${process.platform}.\n`);
  process.exit(0);
}

if (!hasNativeTestRenderer) {
  throw new Error(
    `Expected TestGpuixRenderer on ${process.platform}, but GPUIX reported it unavailable.`,
  );
}

process.stdout.write(`Native GPUIX test renderer available on ${process.platform}.\n`);
