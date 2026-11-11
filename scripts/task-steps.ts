// The tasks `run-steps.ts` knows, built from the root package.json scripts so
// they stay the single source of truth: `lint` is `oxlint . && bun run
// fitness:layering && …`, and each `&&` part becomes one step. Steps of a task
// are independent checks, so the runner may run them side by side, except in
// a `sequential` task (build: later packages may read earlier outputs).

export interface TaskStepDef {
  /** The command, as written in the script. */
  id: string;
  /** Short label: the script name for `bun run x`, else the command. */
  name: string;
}

export interface TaskDef {
  name: string;
  steps: TaskStepDef[];
  sequential: boolean;
}

type Scripts = Record<string, string | undefined>;

/** `bun run [--cwd packages/x] <script>` or `bun path/to/<file>.ts` → its label. */
function stepName(command: string): string {
  const cwd = /^bun run --cwd (?:packages\/)?(\S+) (\S+)$/.exec(command);
  if (cwd) return `${cwd[1]}:${cwd[2]}`;
  const script = /^bun run (\S+)$/.exec(command);
  if (script) return script[1];
  const file = /^bun (?:\S+\/)?([\w-]+)\.ts$/.exec(command);
  return file ? file[1] : command;
}

/** The `&&` parts of a script, one step each. */
export function stepsOf(script: string): TaskStepDef[] {
  return script
    .split('&&')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((id) => ({ id, name: stepName(id) }));
}

const SEQUENTIAL = new Set(['build']);

/** Tasks whose steps come straight from a root script of the same name. */
const SCRIPT_TASKS = ['lint', 'typecheck', 'build'];

/**
 * The task `name`, or null when it is unknown. `verify` is lint, typecheck and
 * the test runner together: the checks to pass before pushing.
 */
export function taskFor(name: string, scripts: Scripts): TaskDef | null {
  if (name === 'verify') {
    const parts = ['lint', 'typecheck'].map((task) => taskFor(task, scripts));
    if (parts.some((part) => !part)) return null;
    const test = { id: 'bun scripts/run-tests.ts', name: 'run-tests' };
    return { name, steps: [...parts.flatMap((part) => part!.steps), test], sequential: false };
  }
  const script = SCRIPT_TASKS.includes(name) ? scripts[name] : undefined;
  if (!script) return null;
  return { name, steps: stepsOf(script), sequential: SEQUENTIAL.has(name) };
}

export const TASK_NAMES = [...SCRIPT_TASKS, 'verify'];
