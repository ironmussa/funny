# Writing tests for `bun test`

Every package's unit tests run on `bun test` (`bun:test`). The client's Storybook
interaction tests are the one exception: they need a real browser and stay on vitest
(`bun run --cwd packages/client test:storybook`).

## Running

- A package: `bun run test` in it (`bun test --parallel` for `core`, `harness`,
  `runtime` and `client`: every file in a fresh global and module registry).
- One file: `bun test ./src/path/x.test.ts` (keep the `./`).
- Everything: `bun run test` at the root (`scripts/run-tests.ts`).
- Coverage gate: `bun run test:coverage` (`scripts/coverage-gate.ts`, "All files" line %).

Preloads (each package's `bunfig.toml`):

- **client:** `src/__tests__/dom-environment.ts` gives every file a jsdom window
  (window events and `FileReader` routed to jsdom), `vite-query-imports.ts` resolves
  `?url` / `?worker` imports, `setup.ts` adds jest-dom matchers, RTL cleanup and
  polyfills.
- **runtime:** `src/__tests__/isolate-data-dir.ts` points `FUNNY_DATA_DIR` at a temp dir,
  so no test reads or writes `~/.funny` (a PTY daemon a test starts would otherwise
  replace the user's `pty.sock`).

## `@funny/test-kit`

What `bun:test` lacks from vitest: `stubGlobal` / `unstubAllGlobals`, `stubEnv` /
`unstubAllEnvs` (undo them in `afterEach`), `waitFor`, `advanceTimersByTimeAsync`,
`runAllTimersAsync`, `runOnlyPendingTimersAsync`, `mocked` (a type cast) and
`expectRejection`.

## Differences that bite

**Imports and globals**

- A file that imports anything from `bun:test` gets no injected globals: import every
  `describe` / `it` / `expect` / hook it uses.

**Module mocks**

- Use `mock.module` (import `mock` from `bun:test`), never `vi.mock`. From Bun 1.4.6,
  `vi.mock` is hoisted above the file's imports and top-level variables, as in vitest, so a
  factory that reads a variable declared before it throws "Cannot access 'x' before
  initialization"; on 1.4.4 it is not hoisted. `mock.module` is not hoisted on either, so a
  test means the same on both. `bun run lint` refuses `vi.mock`.
- `mock.module` is not hoisted. Static imports run first, so a module that
  does work at import time (creates a store or logger, reads `DATA_DIR`, captures an API)
  sees the real dependency. Mock first, then load the module under test, and every module
  that must see the mocks, with `await import()`.
- No `importOriginal` / `vi.importActual`. Copy the real module before mocking it, since
  bun patches the live namespace afterwards:
  `const actual = { ...(await import('../x.js')) }; mock.module('../x.js', () => ({ ...actual, f }));`
- When the mock runs before the module's first import, the factory must provide every
  export the code imports: a missing one is a load error ("Export named 'X' not found").
- A getter in a factory is read once. Call `mock.module` again to change the value.
- Do not `await import()` another mocked module inside a factory: share one mock object.
- Module mocks are not undone by `mock.restore()`; `--parallel` / `--isolate` keeps them
  inside their file.
- No `vi.resetModules()`. For a fresh instance, use ``await import(`../x?fresh=${++n}`)``.

**Promises and timers**

- `expect(promise).rejects` / `.resolves` waits for the promise on the spot. An
  expectation created before the promise settles (then timers advanced, or an abort sent)
  hangs the file. Use `expectRejection(promise, message)`, or settle the promise first.
- `vi.useFakeTimers()` fakes `Date` too and takes no options (`toFake` is a type error).
  Use `setSystemTime` from `bun:test`. No `vi.runAllTicks`; await a few microtasks.

**Mocks and matchers**

- `mockReset()` drops the implementation passed to `vi.fn(impl)`: set it again.
- `spyOn` cannot replace getters: use `Object.defineProperty` and restore it.
- `toHaveBeenCalledOnce()` works at runtime but is not typed: use
  `toHaveBeenCalledTimes(1)`.
- These do not exist: `toHaveBeenCalledExactlyOnceWith`, `expect.poll`,
  `expect.unreachable`.
- `toHaveProperty('a.b')` is always a nested path: use `['a.b']` for a literal key.
- `toMatchObject` with asymmetric matchers writes the matchers into the received object:
  assert on a copy.
- Snapshot keys are `describe test 1`, not vitest's `describe > test 1`.

**Typing**

- bun-types is stricter than vitest's: `Mock` needs its type argument, partial fixtures
  need `expect<unknown>(value).toEqual(...)`, an untyped `test.each` table needs a type
  argument, and `mockResolvedValue` is `never` on a function that may return a plain value
  (use `mockImplementation(async () => value)`).

**Runtime behavior**

- `os.homedir()` does not follow later changes to `process.env.HOME`: mock `os`.
- A failing `expect(domNode).toBeNull()` prints the whole jsdom graph (10–20 s): use
  `.not.toBeInTheDocument()`.
