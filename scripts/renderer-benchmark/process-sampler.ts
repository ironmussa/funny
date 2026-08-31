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
