import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock utils to provide deterministic getRandomColor
vi.mock('../app/scripts/utils.js', () => ({ getRandomColor: () => '#DEADBEEF'.slice(0,7) }));
// Mock UI modules that registerSchoolNames imports
vi.mock('../app/scripts/schools.js', () => ({ updateSchoolList: () => {} }));
vi.mock('../app/scripts/paint.js', () => ({ refreshStyles: () => {} }));
vi.mock('../app/scripts/stats.js', () => ({ calculateStatistics: () => {} }));

import { registerSchoolNames } from '../app/scripts/importHelpers.js';
import { state } from '../app/scripts/state.js';

describe('importHelpers.registerSchoolNames', () => {
  beforeEach(() => {
    state.schools.clear();
    state.activeSchools.clear();
    state.currentSchool = null;
  });

  it('registers new schools and marks active', async () => {
    await registerSchoolNames(['X', 'Y']);
    expect(state.schools.has('X')).toBe(true);
    expect(state.schools.get('X').color).toMatch(/^#[0-9A-F]{6}$/i);
    expect(state.activeSchools.has('X')).toBe(true);
    expect(state.currentSchool).toBe('X');
  });

  it('handles legacy string entries by converting to object', async () => {
    state.schools.set('Z', 'purple');
    await registerSchoolNames(['Z']);
    const val = state.schools.get('Z');
    expect(typeof val).toBe('object');
    expect(val.color).toBe('purple');
  });
});
