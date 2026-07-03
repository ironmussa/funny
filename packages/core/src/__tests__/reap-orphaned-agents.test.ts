/**
 * Tests for agents/reap-orphaned-agents.ts
 *
 * Covers the pure decision + parsing logic of the orphaned-agent reaper that
 * cleans up codex-acp (and sibling ACP) processes leaked by a full --watch
 * restart. The /proc-scanning IO is not unit-tested here (it's a thin wrapper).
 */
import { describe, test, expect } from 'bun:test';

import {
  AGENT_OWNER_ENV,
  buildAgentChildEnv,
  parseOwnerFromEnviron,
  parsePgrpFromStat,
  selectReapablePids,
  type ProcEntry,
} from '../agents/reap-orphaned-agents.js';

describe('buildAgentChildEnv', () => {
  test('stamps the owner pid and merges extra env over process.env', () => {
    const env = buildAgentChildEnv({ FOO: 'bar' }, 4321);
    expect(env[AGENT_OWNER_ENV]).toBe('4321');
    expect(env.FOO).toBe('bar');
    expect(env.PATH).toBe(process.env.PATH);
  });

  test('defaults the owner to the current process pid', () => {
    expect(buildAgentChildEnv()[AGENT_OWNER_ENV]).toBe(String(process.pid));
  });
});

describe('parseOwnerFromEnviron', () => {
  test('extracts the owner pid from a NUL-separated environ blob', () => {
    const blob = `PATH=/usr/bin\0${AGENT_OWNER_ENV}=13267\0HOME=/home/x\0`;
    expect(parseOwnerFromEnviron(blob)).toBe(13267);
  });

  test('returns null when the tag is absent', () => {
    expect(parseOwnerFromEnviron('PATH=/usr/bin\0HOME=/home/x\0')).toBeNull();
  });

  test('returns null for a non-positive or malformed pid', () => {
    expect(parseOwnerFromEnviron(`${AGENT_OWNER_ENV}=0\0`)).toBeNull();
    expect(parseOwnerFromEnviron(`${AGENT_OWNER_ENV}=nope\0`)).toBeNull();
  });
});

describe('parsePgrpFromStat', () => {
  test('parses pgrp even when comm contains spaces and parens', () => {
    // pid (comm) state ppid pgrp ...
    const stat = '4242 (codex (acp)) S 1 4242 4242 0 -1 4194560 ...';
    expect(parsePgrpFromStat(stat)).toBe(4242);
  });

  test('parses a plain comm', () => {
    expect(parsePgrpFromStat('100 (node) S 1 200 200')).toBe(200);
  });

  test('returns null on malformed input', () => {
    expect(parsePgrpFromStat('garbage-without-paren')).toBeNull();
  });
});

describe('selectReapablePids', () => {
  const alive = (live: number[]) => (pid: number) => live.includes(pid);

  test('reaps a group leader whose owner runtime is dead', () => {
    const entries: ProcEntry[] = [{ pid: 500, pgrp: 500, ownerPid: 13267 }];
    expect(selectReapablePids(entries, alive([]))).toEqual([500]);
  });

  test('keeps an agent whose owner runtime is still alive (adopted / other instance)', () => {
    const entries: ProcEntry[] = [{ pid: 500, pgrp: 500, ownerPid: 999 }];
    expect(selectReapablePids(entries, alive([999]))).toEqual([]);
  });

  test('deduplicates members of the same orphaned process group', () => {
    const entries: ProcEntry[] = [
      { pid: 500, pgrp: 500, ownerPid: 13267 },
      { pid: 511, pgrp: 500, ownerPid: 13267 },
    ];
    expect(selectReapablePids(entries, alive([]))).toEqual([500]);
  });

  test('reaps an orphaned process group even when the leader already exited', () => {
    const entries: ProcEntry[] = [{ pid: 511, pgrp: 500, ownerPid: 13267 }];
    expect(selectReapablePids(entries, alive([]))).toEqual([500]);
  });

  test('keeps a process group if any tagged member has a live owner', () => {
    const entries: ProcEntry[] = [
      { pid: 511, pgrp: 500, ownerPid: 13267 },
      { pid: 512, pgrp: 500, ownerPid: 999 },
    ];
    expect(selectReapablePids(entries, alive([999]))).toEqual([]);
  });

  test('reaps multiple orphaned process groups', () => {
    const entries: ProcEntry[] = [
      { pid: 500, pgrp: 500, ownerPid: 1000 },
      { pid: 600, pgrp: 600, ownerPid: 1001 },
      { pid: 700, pgrp: 700, ownerPid: 2000 }, // owner alive → keep
    ];
    expect(selectReapablePids(entries, alive([2000]))).toEqual([500, 600]);
  });
});
