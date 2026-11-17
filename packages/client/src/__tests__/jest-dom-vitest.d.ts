// Vitest 5 declares `Assertion<R, T>` with two type parameters. The
// augmentation shipped in `@testing-library/jest-dom/vitest` still declares
// `Assertion<T>`, which TypeScript cannot merge, so its matchers vanish from
// `expect(...)`. Attach them through `Matchers<R, T>`, which `Assertion` and
// `ExpectStatic` both extend. Drop this file once jest-dom supports Vitest 5.
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';

declare module 'vitest' {
  interface Matchers<
    R extends void | Promise<void> = void | Promise<void>,
    T = unknown,
  > extends TestingLibraryMatchers<unknown, R> {}
}
