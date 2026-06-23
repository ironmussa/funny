import { describe, expect, test } from 'bun:test';

import { resolveCorsOrigins } from '../../lib/cors-origins.js';

describe('resolveCorsOrigins', () => {
  test('allows both localhost and 127.0.0.1 for dev and built server ports', () => {
    expect(resolveCorsOrigins({ VITE_PORT: '5173', PORT: '3001' } as any)).toEqual([
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:3001',
      'http://127.0.0.1:3001',
    ]);
  });

  test('adds explicit CORS_ORIGIN values without dropping local app origins', () => {
    expect(
      resolveCorsOrigins({
        VITE_PORT: '5173',
        PORT: '3001',
        CORS_ORIGIN: 'https://app.example.com, http://localhost:5173 ',
      } as any),
    ).toEqual([
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:3001',
      'http://127.0.0.1:3001',
      'https://app.example.com',
    ]);
  });
});
