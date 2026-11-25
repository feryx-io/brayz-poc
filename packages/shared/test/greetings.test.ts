import { describe, expect, it } from 'vitest';
import { DEFAULT_WELCOME_BACK_LINES, fillGuestName, fillStaffName, pickLine } from '../src/domain.js';

describe('pickLine — which of several lines a call gets', () => {
  const lines = ['one', 'two', 'three'];

  it('cycles a recognized caller through the lines by how often they have called', () => {
    expect([0, 1, 2, 3, 4].map((priorCalls) => pickLine(lines, { priorCalls }))).toEqual([
      'one',
      'two',
      'three',
      'one',
      'two',
    ]);
  });

  it('gives a stranger one at random, always from the list', () => {
    expect(pickLine(lines, { random: 0 })).toBe('one');
    expect(pickLine(lines, { random: 0.5 })).toBe('two');
    expect(pickLine(lines, { random: 0.999 })).toBe('three');
  });

  it('is the single line itself, and nothing from an empty list', () => {
    expect(pickLine(['only'], { priorCalls: 7 })).toBe('only');
    expect(pickLine([], { priorCalls: 0 })).toBeUndefined();
    expect(pickLine([], { random: 0.3 })).toBeUndefined();
  });

  it('ships welcome-back variants that all name the guest', () => {
    for (const line of DEFAULT_WELCOME_BACK_LINES) expect(line).toContain('{guest_name}');
    expect(fillGuestName(DEFAULT_WELCOME_BACK_LINES[1]!, 'Dana')).toBe('Hey Dana, good to hear from you!');
  });

  it('fills the speaker placeholder, Brayz when unnamed', () => {
    expect(fillStaffName('This is {staff_name}.', 'Sam')).toBe('This is Sam.');
    expect(fillStaffName('This is {staff_name}.', null)).toBe('This is Brayz.');
  });
});
