import { describe, expect, test } from 'bun:test';

import { leftViewOf, withLeftView } from '@/lib/left-view';

describe('leftViewOf', () => {
  test('the board, the queue and the inbox fill the window on their own route', () => {
    expect(leftViewOf('/factory', '')).toEqual({ view: 'factory', fillsWindow: true });
    expect(leftViewOf('/acme/kanban', '')).toEqual({ view: 'kanban', fillsWindow: true });
    expect(leftViewOf('/inbox/automations', '?project=p1')).toEqual({
      view: 'inbox',
      fillsWindow: true,
    });
  });

  test('`?left=` shows a view beside the thread', () => {
    expect(leftViewOf('/projects/p1/threads/t1', '?left=factory&panel=files')).toEqual({
      view: 'factory',
      fillsWindow: false,
    });
    expect(leftViewOf('/scratch/s1', '?left=inbox')).toEqual({ view: 'inbox', fillsWindow: false });
  });

  // Regression: going back from `/factory` to a thread must show the thread
  // list, so nothing but the URL may name the view.
  test('a route that names no view shows the thread list', () => {
    const threads = { view: 'threads', fillsWindow: false } as const;
    expect(leftViewOf('/', '')).toEqual(threads);
    expect(leftViewOf('/projects/p1/threads/t1', '')).toEqual(threads);
    expect(leftViewOf('/projects/p1/threads/t1', '?panel=files')).toEqual(threads);
    expect(leftViewOf('/list', '')).toEqual(threads);
    expect(leftViewOf('/grid', '')).toEqual(threads);
  });

  test('an unknown `left` value is the thread list', () => {
    expect(leftViewOf('/projects/p1/threads/t1', '?left=threads').view).toBe('threads');
    expect(leftViewOf('/projects/p1/threads/t1', '?left=constructor').view).toBe('threads');
  });

  test('a view on its own route ignores `?left=`', () => {
    expect(leftViewOf('/factory', '?left=kanban')).toEqual({ view: 'factory', fillsWindow: true });
  });
});

describe('withLeftView', () => {
  test('adds the view to a path, keeping its other parameters', () => {
    expect(withLeftView('/projects/p1/threads/t1', 'factory')).toBe(
      '/projects/p1/threads/t1?left=factory',
    );
    expect(withLeftView('/projects/p1/threads/t1?panel=files', 'kanban')).toBe(
      '/projects/p1/threads/t1?panel=files&left=kanban',
    );
  });

  test('the thread list removes the parameter', () => {
    expect(withLeftView('/projects/p1/threads/t1?left=factory&panel=files', 'threads')).toBe(
      '/projects/p1/threads/t1?panel=files',
    );
    expect(withLeftView('/projects/p1/threads/t1?left=factory', null)).toBe(
      '/projects/p1/threads/t1',
    );
  });
});
