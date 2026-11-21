import { expect, test } from 'bun:test';

import { render, screen } from '@testing-library/react';

// dom-environment.ts prints a DOM node as its markup. Without it, a failing
// matcher on a node serializes jsdom's whole object graph (megabytes, seconds),
// and a `waitFor` that polls such a matcher blocks the event loop until the
// test times out.
test('a failing matcher prints a DOM node as short markup', () => {
  render(
    <div data-testid="box">
      <input defaultValue="x" />
      <button type="button">ok</button>
    </div>,
  );
  const node = screen.getByTestId('box');

  let message = '';
  try {
    expect(node).toBeNull();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  expect(message).toContain('<div data-testid="box">');
  expect(message.length).toBeLessThan(1000);
});
