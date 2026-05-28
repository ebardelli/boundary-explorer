import { describe, it, expect } from 'vitest';

describe('window availability', () => {
  it('should have window defined', () => {
    expect(typeof window).toBe('object');
    expect(window).not.toBeUndefined();
  });

  it('should have document defined', () => {
    expect(typeof document).toBe('object');
    expect(document).not.toBeUndefined();
  });
});