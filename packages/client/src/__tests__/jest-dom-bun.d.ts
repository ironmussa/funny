/// <reference types="bun-types/test" />
// Attach @testing-library/jest-dom's matchers (registered by setup.ts) to
// bun:test's `expect(...)`.
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';

declare module 'bun:test' {
  interface Matchers<T> extends TestingLibraryMatchers<unknown, T> {}
  interface AsymmetricMatchers extends TestingLibraryMatchers<unknown, unknown> {}
}
