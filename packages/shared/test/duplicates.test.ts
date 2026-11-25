import { describe, expect, it } from 'vitest';
import { normalizePostalCode, normalizeRestaurantName, normalizeStreetAddress } from '../src/domain.js';

describe('normalizeRestaurantName — the same name however it was typed', () => {
  it('sets aside case, punctuation, a leading "the" and a generic trailing word', () => {
    expect(normalizeRestaurantName("Jimmy's Pizza")).toBe('jimmys pizza');
    expect(normalizeRestaurantName('JIMMYS PIZZA restaurant')).toBe('jimmys pizza');
    expect(normalizeRestaurantName('The Jimmy’s Pizza')).toBe('jimmys pizza');
    expect(normalizeRestaurantName('Fish & Chips')).toBe('fish and chips');
  });
  it('is deliberately exact once normalized', () => {
    expect(normalizeRestaurantName("Jimmy's Pizzeria")).not.toBe(normalizeRestaurantName("Jimmy's Pizza"));
  });
});

describe('normalizeStreetAddress — the same street however it was typed', () => {
  it('agrees across abbreviations, punctuation and unit numbers', () => {
    expect(normalizeStreetAddress('123 Main Street')).toBe('123 main st');
    expect(normalizeStreetAddress('123 main st.')).toBe('123 main st');
    expect(normalizeStreetAddress('123 Main St, Suite 4')).toBe('123 main st');
    expect(normalizeStreetAddress('45 North Broadway Avenue')).toBe('45 n broadway ave');
  });
  it('keeps different numbers different', () => {
    expect(normalizeStreetAddress('123 Main St')).not.toBe(normalizeStreetAddress('125 Main St'));
  });
});

describe('normalizePostalCode', () => {
  it('reads a ZIP+4 as its ZIP', () => {
    expect(normalizePostalCode('12801-1234')).toBe('12801');
    expect(normalizePostalCode(' 12801 ')).toBe('12801');
    expect(normalizePostalCode('K1A 0B1')).toBe('k1a 0b1');
  });
});
