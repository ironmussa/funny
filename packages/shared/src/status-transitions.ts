import { getNextSnapshot, type AnyStateMachine } from 'xstate';

/**
 * For a flat machine whose states are the values of a stored `status` column:
 * the states each status may be written from. A writer that only knows the
 * status it wants to store (the runner's data channel sends target statuses)
 * turns it into a compare-and-set: `WHERE status IN (from[target])`.
 */
export function statusWriteGuards<S extends string>(
  machine: AnyStateMachine,
): Readonly<Record<S, readonly S[]>> {
  const states = Object.keys(machine.states) as S[];
  const guards = Object.fromEntries(states.map((s) => [s, [] as S[]])) as Record<S, S[]>;
  for (const from of states) {
    const snapshot = machine.resolveState({ value: from, context: undefined });
    for (const type of Object.keys(machine.states[from].on)) {
      const to = getNextSnapshot(machine, snapshot, { type }).value as S;
      if (!guards[to].includes(from)) guards[to].push(from);
    }
  }
  return guards;
}
