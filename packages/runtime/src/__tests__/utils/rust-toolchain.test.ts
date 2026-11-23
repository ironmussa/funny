import { afterEach, describe, expect, test } from 'bun:test';

import { readCargoVersion } from '../../utils/rust-toolchain.js';
import { countEventLoopTurns, installSlowBinary } from '../helpers/slow-binary.js';

let restore: (() => void) | null = null;

afterEach(() => {
  restore?.();
  restore = null;
});

describe.skipIf(process.platform === 'win32')('readCargoVersion', () => {
  test('keeps the event loop running while cargo answers (#227)', async () => {
    restore = installSlowBinary('cargo', 'cargo 1.99.0 (fake)');

    const { result, turns } = await countEventLoopTurns(() => readCargoVersion());

    expect(result).toBe('cargo 1.99.0 (fake)');
    // cargo sleeps 400 ms; a sync spawn would let the 10 ms timer run ~0 times.
    expect(turns).toBeGreaterThanOrEqual(10);
  });

  test('answers null when cargo is not on PATH', async () => {
    const previousPath = process.env.PATH;
    process.env.PATH = '/nonexistent-funny-path';
    restore = () => {
      process.env.PATH = previousPath;
    };

    expect(await readCargoVersion()).toBeNull();
  });
});
