import { describe, expect, it } from 'vitest';
import { formatDeliveryAddress, houseNumber, normalizeZip, parseZipList } from '@brayz/shared';
import { checkDeliveryArea, decideArea, haversineMiles, type DeliveryLocation } from '../src/lib/delivery.js';
import { CensusGeocodingProvider, type GeocodingProvider } from '../src/lib/geocoding.js';

const SARATOGA = { lat: 43.0831, lng: -73.7846 };
const ALBANY = { lat: 42.6526, lng: -73.7562 };

describe('delivery area — the either-rule', () => {
  const both = { zipCodes: ['12866', '12831'], radiusMiles: 5 };

  it('has no check when neither rule is set', () => {
    expect(decideArea({ zipCodes: [], radiusMiles: null }, { zip: null, distanceMiles: null })).toEqual({
      check: 'no_rules',
      deliverable: true,
    });
  });

  it('lets a listed ZIP through whatever the distance', () => {
    expect(decideArea(both, { zip: '12831-4455', distanceMiles: 22 })).toEqual({ check: 'in_zip', deliverable: true });
  });

  it('lets an address within the radius through whatever its ZIP', () => {
    expect(decideArea(both, { zip: '12020', distanceMiles: 4.2 })).toEqual({ check: 'in_radius', deliverable: true });
  });

  it('refuses only when every rule has answered no', () => {
    expect(decideArea(both, { zip: '12020', distanceMiles: 9 })).toEqual({ check: 'outside', deliverable: false });
    expect(decideArea({ zipCodes: ['12866'], radiusMiles: null }, { zip: '12020', distanceMiles: null }).check).toBe(
      'outside',
    );
  });

  it('asks for the ZIP when ZIPs are a rule and none was given', () => {
    expect(decideArea(both, { zip: null, distanceMiles: 9 })).toEqual({ check: 'needs_zip', deliverable: false });
  });

  it('takes the order flagged when the address could not be placed and nothing else says yes', () => {
    expect(decideArea({ zipCodes: [], radiusMiles: 5 }, { zip: null, distanceMiles: null })).toEqual({
      check: 'unverified',
      deliverable: true,
    });
    expect(decideArea(both, { zip: '12020', distanceMiles: null }).check).toBe('unverified');
  });
});

describe('distance', () => {
  it('measures as the crow flies', () => {
    expect(haversineMiles(SARATOGA, ALBANY)).toBeGreaterThan(29);
    expect(haversineMiles(SARATOGA, ALBANY)).toBeLessThan(31);
    expect(haversineMiles(SARATOGA, SARATOGA)).toBe(0);
  });
});

describe('checkDeliveryArea', () => {
  const loc: DeliveryLocation = {
    id: 'loc',
    addressLine1: '1 Broadway',
    city: 'Saratoga Springs',
    region: 'NY',
    postalCode: '12866',
    deliveryZipCodes: ['12866'],
    deliveryRadiusMiles: 5,
    latitude: SARATOGA.lat,
    longitude: SARATOGA.lng,
  };
  const geocoderAt = (point: { lat: number; lng: number } | null, zip: string | null = '12020') => {
    const calls: unknown[] = [];
    const g: GeocodingProvider = {
      name: 'fake',
      async geocode(q) {
        calls.push(q);
        return point ? { ...point, matchedAddress: 'somewhere', postalCode: zip } : null;
      },
    };
    return { g, calls };
  };

  it('answers from a listed ZIP without a lookup — a caller is waiting', async () => {
    const { g, calls } = geocoderAt(ALBANY);
    const r = await checkDeliveryArea(loc, { line1: '5 Circular St', postalCode: '12866' }, g);
    expect(r).toMatchObject({ check: 'in_zip', deliverable: true });
    expect(calls).toHaveLength(0);
  });

  it('measures the distance when the ZIP is not listed', async () => {
    const near = { lat: 43.1, lng: -73.75 }; // ~2 miles out
    const { g, calls } = geocoderAt(near);
    const r = await checkDeliveryArea(loc, { line1: '9 Route 29', postalCode: '12020' }, g);
    expect(r.check).toBe('in_radius');
    expect(r.distanceMiles).toBeLessThan(5);
    // The caller's ZIP goes alone: the restaurant's town alongside it would win
    // at the geocoder and answer about a street of that name back home.
    expect(calls[0]).toMatchObject({ street: '9 Route 29', city: null, state: 'NY', postalCode: '12020' });
  });

  it("uses the restaurant's town only when the caller gave no ZIP", async () => {
    const { g, calls } = geocoderAt({ lat: 43.1, lng: -73.75 }, null);
    await checkDeliveryArea(loc, { line1: '9 Route 29' }, g);
    expect(calls[0]).toMatchObject({ street: '9 Route 29', city: 'Saratoga Springs', postalCode: null });
  });

  it('keeps the town the caller themselves gave', async () => {
    const { g, calls } = geocoderAt({ lat: 43.1, lng: -73.75 }, '12020');
    await checkDeliveryArea(loc, { line1: '9 Route 29', city: 'Ballston Spa', postalCode: '12020' }, g);
    expect(calls[0]).toMatchObject({ city: 'Ballston Spa' });
  });

  it('throws away a match that landed in a different ZIP, and takes the order flagged', async () => {
    // The 2026-09-11 call: the match came back in the restaurant's own ZIP,
    // 3.6 miles out, for an address ten miles away.
    const { g } = geocoderAt({ lat: 43.1, lng: -73.75 }, '12831');
    const r = await checkDeliveryArea(loc, { line1: '40 Example Street', postalCode: '12801' }, g);
    expect(r).toMatchObject({ check: 'unverified', deliverable: true, zipMismatch: true });
    expect(r.distanceMiles).toBeNull();
    expect(r.matchedZip).toBe('12831');
  });

  it('refuses an address that is too far and not on the list', async () => {
    const { g } = geocoderAt(ALBANY, '12207');
    const r = await checkDeliveryArea(loc, { line1: '100 State St', postalCode: '12207' }, g);
    expect(r).toMatchObject({ check: 'outside', deliverable: false });
    expect(r.distanceMiles).toBeGreaterThan(29);
  });

  it('takes the ZIP from the lookup when the caller did not say one', async () => {
    const { g } = geocoderAt({ lat: 43.09, lng: -73.78 }, '12866');
    const r = await checkDeliveryArea({ ...loc, deliveryRadiusMiles: null, deliveryZipCodes: ['12866'] }, { line1: '5 Circular St' }, g);
    // With ZIPs the only rule and no ZIP given, it is asked for rather than looked up.
    expect(r.check).toBe('needs_zip');
  });

  it('flags rather than refuses when the lookup fails', async () => {
    const { g } = geocoderAt(null);
    const r = await checkDeliveryArea(loc, { line1: '9 Nowhere Rd', postalCode: '12020' }, g);
    expect(r).toMatchObject({ check: 'unverified', deliverable: true, distanceMiles: null });
  });
});

describe('address helpers', () => {
  it('normalizes ZIPs and lists of them', () => {
    expect(normalizeZip(' 12866-1234 ')).toBe('12866');
    expect(normalizeZip('')).toBeNull();
    expect(parseZipList('12866, 12831 12866;12020')).toEqual(['12866', '12831', '12020']);
  });

  it('writes an address on one line and finds its house number', () => {
    expect(
      formatDeliveryAddress({ line1: '12 Main Street', line2: 'Apt 2', city: 'Saratoga Springs', postalCode: '12866' }),
    ).toBe('12 Main Street, Apt 2, Saratoga Springs 12866');
    expect(houseNumber('12B Main St')).toBe('12B');
    expect(houseNumber('Main St')).toBeNull();
  });
});

describe('CensusGeocodingProvider', () => {
  it('asks the structured endpoint and reads the first match', async () => {
    const urls: string[] = [];
    const g = new CensusGeocodingProvider(async (url) => {
      urls.push(url);
      return {
        ok: true,
        json: async () => ({
          result: {
            addressMatches: [
              { matchedAddress: '12 MAIN ST, SARATOGA SPRINGS, NY, 12866', coordinates: { x: -73.78, y: 43.08 }, addressComponents: { zip: '12866' } },
            ],
          },
        }),
      };
    });
    const hit = await g.geocode({ street: '12 Main St', city: 'Saratoga Springs', state: 'NY' });
    expect(hit).toEqual({ lat: 43.08, lng: -73.78, matchedAddress: '12 MAIN ST, SARATOGA SPRINGS, NY, 12866', postalCode: '12866' });
    expect(urls[0]).toContain('geocoding.geo.census.gov/geocoder/locations/address?');
    expect(urls[0]).toContain('street=12+Main+St');
  });

  it('returns null — never throws — on no match, a bad response, or a network failure', async () => {
    expect(await new CensusGeocodingProvider(async () => ({ ok: true, json: async () => ({ result: { addressMatches: [] } }) })).geocode({ street: '1 A St', postalCode: '12866' })).toBeNull();
    expect(await new CensusGeocodingProvider(async () => ({ ok: false, json: async () => ({}) })).geocode({ street: '1 A St', postalCode: '12866' })).toBeNull();
    expect(await new CensusGeocodingProvider(async () => { throw new Error('down'); }).geocode({ street: '1 A St', postalCode: '12866' })).toBeNull();
  });

  it('does not ask without a ZIP or a city and state', async () => {
    let called = false;
    const g = new CensusGeocodingProvider(async () => {
      called = true;
      return { ok: true, json: async () => ({}) };
    });
    expect(await g.geocode({ street: '12 Main St', city: 'Saratoga Springs' })).toBeNull();
    expect(called).toBe(false);
  });
});
