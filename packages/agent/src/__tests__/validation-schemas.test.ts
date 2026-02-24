import { describe, it, expect } from 'bun:test';
import { StartSessionSchema } from '../validation/schemas.js';

describe('StartSessionSchema', () => {
  it('accepts valid input with issue_number', () => {
    const result = StartSessionSchema.safeParse({ issue_number: 42 });
    expect(result.success).toBe(true);
  });

  it('accepts valid input with issue_number and project_path', () => {
    const result = StartSessionSchema.safeParse({
      issue_number: 1,
      project_path: '/home/user/project',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing issue_number', () => {
    const result = StartSessionSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects non-integer issue_number', () => {
    const result = StartSessionSchema.safeParse({ issue_number: 1.5 });
    expect(result.success).toBe(false);
  });

  it('rejects issue_number below 1', () => {
    const result = StartSessionSchema.safeParse({ issue_number: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects negative issue_number', () => {
    const result = StartSessionSchema.safeParse({ issue_number: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects non-number issue_number', () => {
    const result = StartSessionSchema.safeParse({ issue_number: 'abc' });
    expect(result.success).toBe(false);
  });

  it('accepts undefined project_path (optional)', () => {
    const result = StartSessionSchema.safeParse({ issue_number: 5 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.project_path).toBeUndefined();
    }
  });

  it('rejects empty project_path', () => {
    const result = StartSessionSchema.safeParse({
      issue_number: 5,
      project_path: '',
    });
    expect(result.success).toBe(false);
  });
});
