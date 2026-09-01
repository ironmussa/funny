import { platform } from 'node:os';

export interface ProcessRecord {
  pid: number;
  parentPid: number;
  rssBytes: number;
  cpuPercent: number;
}

export interface ProcessTreeSample {
  timestampMs: number;
  processCount: number;
  rssBytes: number;
  cpuPercent: number;
}

export type ProcessRole = 'browser' | 'renderer' | 'gpu' | 'utility' | 'zygote' | 'harness';

export interface DetailedProcessRecord extends ProcessRecord {
  command: string;
  role: ProcessRole;
}

export interface DetailedProcessTreeSample extends ProcessTreeSample {
  chromiumRssBytes: number;
  rssBytesByRole: Record<ProcessRole, number>;
  processCountByRole: Record<ProcessRole, number>;
}

const EMPTY_ROLE_TOTALS: Record<ProcessRole, number> = {
  browser: 0,
  renderer: 0,
  gpu: 0,
  utility: 0,
  zygote: 0,
  harness: 0,
};

export function classifyProcessRole(command: string): ProcessRole {
  if (command.includes('--type=renderer')) return 'renderer';
  if (command.includes('--type=gpu-process')) return 'gpu';
  if (command.includes('--type=utility')) return 'utility';
  if (command.includes('--type=zygote')) return 'zygote';
  if (/\b(chrome-headless-shell|chrome|chromium)(?:\s|$)/.test(command)) return 'browser';
  return 'harness';
}

export function parseProcessTable(output: string): ProcessRecord[] {
  const records: ProcessRecord[] = [];
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)$/);
    if (!match) continue;
    records.push({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      rssBytes: Number(match[3]) * 1024,
      cpuPercent: Number(match[4]),
    });
  }
  return records;
}

export function parseDetailedProcessTable(output: string): DetailedProcessRecord[] {
  const records: DetailedProcessRecord[] = [];
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.+)$/);
    if (!match) continue;
    const command = match[5];
    records.push({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      rssBytes: Number(match[3]) * 1024,
      cpuPercent: Number(match[4]),
      command,
      role: classifyProcessRole(command),
    });
  }
  return records;
}

export function aggregateProcessTree(
  rootPid: number,
  records: readonly ProcessRecord[],
  timestampMs = Date.now(),
): ProcessTreeSample | null {
  const byParent = new Map<number, ProcessRecord[]>();
  for (const record of records) {
    const children = byParent.get(record.parentPid) ?? [];
    children.push(record);
    byParent.set(record.parentPid, children);
  }
  const byPid = new Map(records.map((record) => [record.pid, record]));
  const root = byPid.get(rootPid);
  if (!root) return null;
  const included: ProcessRecord[] = [];
  const pending = [root];
  const visited = new Set<number>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current.pid)) continue;
    visited.add(current.pid);
    included.push(current);
    pending.push(...(byParent.get(current.pid) ?? []));
  }
  return {
    timestampMs,
    processCount: included.length,
    rssBytes: included.reduce((total, record) => total + record.rssBytes, 0),
    cpuPercent: included.reduce((total, record) => total + record.cpuPercent, 0),
  };
}

export function aggregateDetailedProcessTree(
  rootPid: number,
  records: readonly DetailedProcessRecord[],
  timestampMs = Date.now(),
): DetailedProcessTreeSample | null {
  const base = aggregateProcessTree(rootPid, records, timestampMs);
  if (!base) return null;

  const byParent = new Map<number, DetailedProcessRecord[]>();
  for (const record of records) {
    const children = byParent.get(record.parentPid) ?? [];
    children.push(record);
    byParent.set(record.parentPid, children);
  }
  const root = records.find((record) => record.pid === rootPid);
  if (!root) return null;

  const rssBytesByRole = { ...EMPTY_ROLE_TOTALS };
  const processCountByRole = { ...EMPTY_ROLE_TOTALS };
  const pending = [root];
  const visited = new Set<number>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current.pid)) continue;
    visited.add(current.pid);
    rssBytesByRole[current.role] += current.rssBytes;
    processCountByRole[current.role] += 1;
    pending.push(...(byParent.get(current.pid) ?? []));
  }

  return {
    ...base,
    chromiumRssBytes: base.rssBytes - rssBytesByRole.harness,
    rssBytesByRole,
    processCountByRole,
  };
}

export async function sampleProcessTree(rootPid: number): Promise<ProcessTreeSample | null> {
  if (platform() !== 'linux' && platform() !== 'darwin') return null;
  const process = Bun.spawn({
    cmd: ['ps', '-axo', 'pid=,ppid=,rss=,%cpu='],
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const output = await new Response(process.stdout).text();
  if ((await process.exited) !== 0) return null;
  return aggregateProcessTree(rootPid, parseProcessTable(output));
}

export async function sampleDetailedProcessTree(
  rootPid: number,
): Promise<DetailedProcessTreeSample | null> {
  if (platform() !== 'linux' && platform() !== 'darwin') return null;
  const process = Bun.spawn({
    cmd: ['ps', '-axo', 'pid=,ppid=,rss=,%cpu=,command='],
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const output = await new Response(process.stdout).text();
  if ((await process.exited) !== 0) return null;
  return aggregateDetailedProcessTree(rootPid, parseDetailedProcessTable(output));
}
