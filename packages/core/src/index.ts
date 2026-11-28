export * from './agents/index.js';
export * from './git/index.js';
export {
  detectEnv,
  resolvePyVenv,
  resolveNodeVersion,
  type DetectedEnv,
  type PyVenvResolution,
  type NodeVersionResolution,
} from './env/index.js';
export { setLogSink } from './debug.js';
export {
  detectTestStack,
  testStackFactsSchema,
  type DetectedPackageManager,
  type DetectedMonorepo,
  type DetectedTestRunner,
  type DetectedTestPackage,
  type DetectedInfraTest,
  type TestStackFacts,
} from './test-stack.js';
