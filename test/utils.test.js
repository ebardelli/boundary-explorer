import { describe, it, expect, vi } from 'vitest';
import { getRandomColor, colorFromName } from '../app/scripts/utils.js';

describe('utils.js', () => {
  it('getRandomColor returns a hex color string', () => {
    const spy = vi.spyOn(Math, 'random').mockImplementation(() => 0.5);
    const c = getRandomColor();
    expect(typeof c).toBe('string');
    expect(c).toMatch(/^#[0-9A-F]{6}$/i);
    spy.mockRestore();
  });

  it('colorFromName returns deterministic hex colors and handles empty values', () => {
    const a = colorFromName('Lincoln Elementary');
    const b = colorFromName('Lincoln Elementary');
    expect(a).toBe(b);
    expect(a).toMatch(/^#[0-9A-F]{6}$/i);

    expect(colorFromName('')).toMatch(/^#[0-9A-F]{6}$/i);
    expect(colorFromName(null)).toMatch(/^#[0-9A-F]{6}$/i);
    expect(colorFromName(undefined)).toMatch(/^#[0-9A-F]{6}$/i);
  });
});
