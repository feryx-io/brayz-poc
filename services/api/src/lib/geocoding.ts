/**
 * Turning an address into a point on the map, for the delivery radius.
 *
 * Behind an interface (CLAUDE.md rule #2): the US Census Geocoder is the first
 * implementation — free, no key, US addresses, which fits the restaurant base —
 * and another vendor is a new adapter here, not a change to delivery logic.
 *
 * A geocoder is asked mid-call, so it is given a short deadline, and it never
 * throws: a lookup that fails or finds nothing returns null, and the caller
 * decides what an unplaced address means (for delivery: taken, flagged).
 */

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface GeocodeQuery {
  street: string;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
}

export interface GeocodeResult extends GeoPoint {
  /** The address as the geocoder understood it — worth logging when a match looks wrong. */
  matchedAddress: string;
  postalCode: string | null;
}

export interface GeocodingProvider {
  readonly name: string;
  geocode(query: GeocodeQuery): Promise<GeocodeResult | null>;
}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

interface CensusResponse {
  result?: {
    addressMatches?: Array<{
      matchedAddress?: string;
      coordinates?: { x?: number; y?: number };
      addressComponents?: { zip?: string };
    }>;
  };
}

/**
 * The US Census Bureau geocoder (geocoding.geo.census.gov). Its structured
 * endpoint wants a street plus either a ZIP or a city and state; without any
 * of those there is nothing reliable to ask, so it does not.
 */
export class CensusGeocodingProvider implements GeocodingProvider {
  readonly name = 'census';

  constructor(
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly timeoutMs = 4000,
  ) {}

  async geocode(query: GeocodeQuery): Promise<GeocodeResult | null> {
    const street = query.street.trim();
    if (!street || !(query.postalCode?.trim() || (query.city?.trim() && query.state?.trim()))) return null;
    const params = new URLSearchParams({ street, benchmark: 'Public_AR_Current', format: 'json' });
    if (query.city?.trim()) params.set('city', query.city.trim());
    if (query.state?.trim()) params.set('state', query.state.trim());
    if (query.postalCode?.trim()) params.set('zip', query.postalCode.trim());
    try {
      const res = await this.fetchImpl(
        `https://geocoding.geo.census.gov/geocoder/locations/address?${params.toString()}`,
        { signal: AbortSignal.timeout(this.timeoutMs) },
      );
      if (!res.ok) return null;
      const match = ((await res.json()) as CensusResponse).result?.addressMatches?.[0];
      const x = match?.coordinates?.x;
      const y = match?.coordinates?.y;
      if (typeof x !== 'number' || typeof y !== 'number') return null;
      return {
        lat: y,
        lng: x,
        matchedAddress: match?.matchedAddress ?? '',
        postalCode: match?.addressComponents?.zip ?? null,
      };
    } catch {
      return null;
    }
  }
}

/** The configured geocoder. One implementation today; config picks between adapters when there are more. */
export function buildGeocoder(): GeocodingProvider {
  return new CensusGeocodingProvider();
}
