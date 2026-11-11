// Types for the plain-JS reporter (it runs inside a project's own vitest, so it
// cannot be TypeScript the project would have to compile).

export const TEST_EVENT_PREFIX: string;

interface Module {
  moduleId: string;
  diagnostic?: () => { duration: number };
}

interface TestCaseLike {
  module: Module;
  fullName: string;
  result: () => { state: string; errors?: unknown[] };
  diagnostic: () => { duration: number } | undefined;
}

export default class ProgressReporter {
  onTestRunStart(specifications: ReadonlyArray<{ moduleId: string }>): void;
  onTestModuleQueued(module: Module): void;
  onTestCaseResult(testCase: TestCaseLike): void;
  onTestModuleEnd(module: Required<Module>): void;
}
