import { describe, test, expect } from 'bun:test';

import { tzOffsetToModifier, getDateRange } from '../../services/analytics-service.js';

// ── tzOffsetToModifier ───────────────────────────────────────────

describe('tzOffsetToModifier', () => {
  test('UTC (offset 0) returns +00:00', () => {
    expect(tzOffsetToModifier(0)).toBe('+00:00');
  });

  test('US Eastern (offset 300) returns -05:00', () => {
    expect(tzOffsetToModifier(300)).toBe('-05:00');
  });

  test('India (offset -330) returns +05:30', () => {
    expect(tzOffsetToModifier(-330)).toBe('+05:30');
  });

  test('JST (offset -540) returns +09:00', () => {
    expect(tzOffsetToModifier(-540)).toBe('+09:00');
  });

  test('Nepal (offset -345) returns +05:45', () => {
    expect(tzOffsetToModifier(-345)).toBe('+05:45');
  });

  test('maximum practical offset 720 returns -12:00', () => {
    expect(tzOffsetToModifier(720)).toBe('-12:00');
  });

  test('negative max offset -720 returns +12:00', () => {
    expect(tzOffsetToModifier(-720)).toBe('+12:00');
  });
});

// ── getDateRange ─────────────────────────────────────────────────

describe('getDateRange', () => {
  test('returns ISO string format for both start and end', () => {
    const range = getDateRange('month');
    expect(range.start).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(range.end).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('day returns range of ~24 hours', () => {
    const range = getDateRange('day');
    const diff = new Date(range.end).getTime() - new Date(range.start).getTime();
    const hours = diff / (1000 * 60 * 60);
    expect(hours).toBeGreaterThanOrEqual(23.9);
    expect(hours).toBeLessThanOrEqual(24.1);
  });

  test('week returns range of ~7 days', () => {
    const range = getDateRange('week');
    const diff = new Date(range.end).getTime() - new Date(range.start).getTime();
    const days = diff / (1000 * 60 * 60 * 24);
    expect(days).toBeGreaterThanOrEqual(6.9);
    expect(days).toBeLessThanOrEqual(7.1);
  });

  test('month (default) returns range of ~30 days', () => {
    const range = getDateRange();
    const diff = new Date(range.end).getTime() - new Date(range.start).getTime();
    const days = diff / (1000 * 60 * 60 * 24);
    // Month varies 28-31 days
    expect(days).toBeGreaterThanOrEqual(27);
    expect(days).toBeLessThanOrEqual(32);
  });

  test('all starts at epoch', () => {
    const range = getDateRange('all');
    const start = new Date(range.start);
    expect(start.getTime()).toBe(0);
  });

  test('custom startDate and endDate override calculation', () => {
    const range = getDateRange('month', 0, '2024-06-01T00:00:00Z', '2024-06-30T00:00:00Z');
    expect(range.start).toBe('2024-06-01T00:00:00.000Z');
    expect(range.end).toBe('2024-06-30T00:00:00.000Z');
  });

  test('default (no timeRange) behaves like month', () => {
    const defaultRange = getDateRange();
    const monthRange = getDateRange('month');
    // Both should produce roughly the same range (within a few ms)
    const defaultDiff =
      new Date(defaultRange.end).getTime() - new Date(defaultRange.start).getTime();
    const monthDiff = new Date(monthRange.end).getTime() - new Date(monthRange.start).getTime();
    expect(Math.abs(defaultDiff - monthDiff)).toBeLessThan(1000);
  });
});
