import { describe, expect, test } from 'bun:test';

import { detectNativeHostSupport } from '../host-support';

describe('GPUIX product host support', () => {
  test.each([
    ['darwin', 'arm64', undefined, 'aarch64-apple-darwin'],
    ['darwin', 'x64', undefined, 'x86_64-apple-darwin'],
    ['linux', 'arm64', 'glibc', 'aarch64-unknown-linux-gnu'],
    ['linux', 'x64', 'glibc', 'x86_64-unknown-linux-gnu'],
    ['win32', 'arm64', undefined, 'aarch64-pc-windows-msvc'],
    ['win32', 'x64', undefined, 'x86_64-pc-windows-msvc'],
  ])('recognizes published %s/%s targets', (platform, architecture, linuxLibc, target) => {
    expect(detectNativeHostSupport({ platform, architecture, linuxLibc })).toMatchObject({
      supported: true,
      target,
    });
  });

  test('rejects Linux musl with the web fallback', () => {
    expect(
      detectNativeHostSupport({ platform: 'linux', architecture: 'x64', linuxLibc: 'musl' }),
    ).toEqual({
      supported: false,
      reason: 'GPUIX 0.5.1 requires glibc on Linux; detected musl',
      fallbackCommand: 'bun run dev:client',
    });
  });

  test('rejects unpublished platforms and architectures', () => {
    expect(detectNativeHostSupport({ platform: 'freebsd', architecture: 'x64' }).supported).toBe(
      false,
    );
    expect(detectNativeHostSupport({ platform: 'darwin', architecture: 'riscv64' }).supported).toBe(
      false,
    );
  });
});
