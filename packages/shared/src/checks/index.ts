/**
 * Checks an agent runs (tests, type check, lint, format, build): recognising
 * the command, and reading its output into the test-progress / task-progress
 * shapes the thread's widgets show. Pure functions, no I/O.
 */
export {
  classifyCheckCommand,
  scriptKind,
  type CheckCommand,
  type CheckKind,
  type CheckTool,
} from './classify.js';
export { checkInputKey } from './input-key.js';
export { createStepParser, type StepParser, type StepReport } from './step-output.js';
export {
  createOutputParser,
  isEventLine,
  suiteFields,
  TEST_EVENT_PREFIX,
  type OutputParser,
  type SuiteCounts,
  type TestEvent,
} from './test-output.js';
