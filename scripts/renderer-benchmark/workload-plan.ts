import {
  BENCHMARK_WORKLOAD_NAMES,
  type BenchmarkCommand,
} from '../../packages/client-benchmark/src/index';

export function workloadCommands(measured: boolean): BenchmarkCommand[] {
  const commands: BenchmarkCommand[] = [];
  for (const [index, workload] of BENCHMARK_WORKLOAD_NAMES.entries()) {
    if (measured && workload === 'repeated-navigation') {
      commands.push({
        type: 'run-workload',
        id: `repeated-navigation-prime-${index}`,
        workload,
        measured: true,
      });
    }
    commands.push({
      type: 'run-workload',
      id: `${workload}-${index}`,
      workload,
      measured,
    });
  }
  return commands;
}
