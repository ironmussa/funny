import { describe, expect, test } from 'bun:test';

import { workloadCommands } from '../workload-plan';

describe('renderer benchmark workload plan', () => {
  test('stabilizes repeated navigation before the measured memory window', () => {
    const repeated = workloadCommands(true).filter(
      (command) => command.type === 'run-workload' && command.workload === 'repeated-navigation',
    );
    expect(repeated).toEqual([
      {
        type: 'run-workload',
        id: 'repeated-navigation-prime-6',
        workload: 'repeated-navigation',
        measured: true,
      },
      {
        type: 'run-workload',
        id: 'repeated-navigation-6',
        workload: 'repeated-navigation',
        measured: true,
      },
    ]);
  });

  test('does not add the stabilization pass to smoke sessions', () => {
    expect(
      workloadCommands(false).filter(
        (command) => command.type === 'run-workload' && command.workload === 'repeated-navigation',
      ),
    ).toHaveLength(1);
  });
});
