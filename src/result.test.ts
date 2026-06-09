import { describe, expect, it } from 'vitest';
import { err, ok } from './result.js';

describe('Result', () => {
  it('ok wraps data into success variant', () => {
    const result = ok(42);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe(42);
    }
  });

  it('err wraps error into failure variant', () => {
    const result = err('boom');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('boom');
    }
  });
});
