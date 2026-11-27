import { describe, expect, test } from 'bun:test';

import {
  createColumnIds,
  insertColumnId,
  removeColumnId,
  resizeColumnIds,
  withInsertedColumn,
  withoutColumn,
} from '@/components/live-columns/grid-layout';

describe('grid-layout', () => {
  test('withoutColumn drops a column and shifts columns to its right left', () => {
    // 3x2 grid:
    // row 0: [t0, t1, t2] -> indices 0, 1, 2
    // row 1: [t3, t4, t5] -> indices 3, 4, 5
    const assignments = {
      '0': 't0',
      '1': 't1',
      '2': 't2',
      '3': 't3',
      '4': 't4',
      '5': 't5',
    };

    expect(withoutColumn(assignments, 0, 3)).toEqual({
      '0': 't1',
      '1': 't2',
      '2': 't4',
      '3': 't5',
    });

    expect(withoutColumn(assignments, 1, 3)).toEqual({
      '0': 't0',
      '1': 't2',
      '2': 't3',
      '3': 't5',
    });
  });

  test('withInsertedColumn shifts columns at or right of insertIndex right', () => {
    // 2x2 grid:
    // row 0: [t0, t1] -> indices 0, 1
    // row 1: [t2, t3] -> indices 2, 3
    const assignments = {
      '0': 't0',
      '1': 't1',
      '2': 't2',
      '3': 't3',
    };

    // Insert at 0 -> 3x2 grid: [_, t0, t1] / [_, t2, t3]
    expect(withInsertedColumn(assignments, 0, 2)).toEqual({
      '1': 't0',
      '2': 't1',
      '4': 't2',
      '5': 't3',
    });

    // Append at 2 -> 3x2 grid: [t0, t1, _] / [t2, t3, _]
    expect(withInsertedColumn(assignments, 2, 2)).toEqual({
      '0': 't0',
      '1': 't1',
      '3': 't2',
      '4': 't3',
    });
  });

  test('column ID helpers preserve surviving IDs on remove, insert, and resize', () => {
    let seq = 0;
    const nextId = () => `col-${seq++}`;

    const initial = createColumnIds(3, nextId);
    expect(initial).toEqual(['col-0', 'col-1', 'col-2']);

    // Removing the first column keeps col-1 and col-2 intact
    const afterRemove = removeColumnId(initial, 0);
    expect(afterRemove).toEqual(['col-1', 'col-2']);

    // Inserting at index 0 preserves col-1 and col-2
    const afterInsert = insertColumnId(afterRemove, 0, nextId());
    expect(afterInsert).toEqual(['col-3', 'col-1', 'col-2']);

    // Growing preserves existing IDs and appends fresh ones
    expect(resizeColumnIds(afterInsert, 4, nextId)).toEqual(['col-3', 'col-1', 'col-2', 'col-4']);

    // Shrinking preserves the prefix IDs
    expect(resizeColumnIds(afterInsert, 2, nextId)).toEqual(['col-3', 'col-1']);
  });
});
