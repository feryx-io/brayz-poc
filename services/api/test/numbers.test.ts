import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every test file that routes a call needs its own phone number.
 *
 * These files share one database and vitest runs them in parallel. A file
 * claims its number by deleting every row for it and recreating it against a
 * location it just made — so two files claiming the same number take each
 * other's calls, at random, depending on which finished second. That is what
 * `pos` and `order-modifiers` did with +15185550131: the loser placed an order
 * for a menu item belonging to a location it was no longer calling, and got a
 * 422 that read like a bug in ordering. It failed three to five cases a run and
 * passed in isolation every time.
 *
 * A collision is invisible in review — the two constants are in different files
 * and neither looks wrong. This makes it a red test instead.
 */
const here = dirname(fileURLToPath(import.meta.url));

describe('test phone numbers', () => {
  it('are not claimed by two files at once', () => {
    const claims = new Map<string, string[]>();
    for (const file of readdirSync(here).filter((f) => f.endsWith('.ts'))) {
      const src = readFileSync(join(here, file), 'utf8');
      // Only declared constants count. A number written inline is a payload,
      // not a claim on the routing table.
      for (const m of src.matchAll(/^const\s+\w*NUMBER\w*\s*=\s*'(\+1\d{10})'/gm)) {
        const list = claims.get(m[1]!) ?? [];
        list.push(file);
        claims.set(m[1]!, list);
      }
    }
    expect(claims.size).toBeGreaterThan(5); // the scan found something to check
    const shared = [...claims].filter(([, files]) => files.length > 1);
    expect(shared.map(([number, files]) => `${number}: ${files.join(', ')}`)).toEqual([]);
  });

  /**
   * Nor is a caller's number. A guest is found by phone across the tenant, so
   * two files calling from the same number share one guest — and a file that
   * deletes its location deletes that guest with it, under the other file's
   * order. That was the Orders API flake: closed-hours called from the same
   * number, cleaned up, and the order being placed pointed at a guest that was
   * gone. Only the number is the same in the two files; neither looks wrong.
   */
  it('are not called from by two files at once', () => {
    const callers = new Map<string, Set<string>>();
    for (const file of readdirSync(here).filter((f) => f.endsWith('.ts'))) {
      const src = readFileSync(join(here, file), 'utf8');
      const found = [
        ...src.matchAll(/fromNumber:\s*'(\+1\d{10})'/g),
        ...src.matchAll(/^const\s+(?:CALLER|STRANGER)\w*\s*=\s*'(\+1\d{10})'/gm),
      ];
      for (const m of found) callers.set(m[1]!, (callers.get(m[1]!) ?? new Set()).add(file));
    }
    expect(callers.size).toBeGreaterThan(10); // the scan found something to check
    const shared = [...callers].filter(([, files]) => files.size > 1);
    expect(shared.map(([number, files]) => `${number}: ${[...files].join(', ')}`)).toEqual([]);
  });
});
