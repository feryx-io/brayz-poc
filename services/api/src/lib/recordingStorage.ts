import crypto from 'node:crypto';

/**
 * Recording playback (CLAUDE.md rule #2 — object storage behind an interface,
 * not a vendor baked into the calls route).
 *
 * SiphonAI uploads recordings to an S3-compatible store and reports the object
 * as `s3://bucket/key`, which a browser cannot play. This turns that into a
 * short-lived signed URL an `<audio>` element can fetch.
 *
 * S3-compatible covers what Brayz actually deploys onto: GCS's S3 interop
 * endpoint, S3 itself, R2, MinIO. One presigner, no SDK — a SigV4 query-string
 * signature is a hash of parts we already have, and pulling in a vendor SDK to
 * compute it would be more surface than the maths.
 */

export interface RecordingLocation {
  bucket: string;
  key: string;
}

export interface RecordingStorage {
  readonly name: string;
  /** A URL that plays this recording, valid for `ttlSeconds`. */
  signedUrl(loc: RecordingLocation, ttlSeconds: number): string;
  /**
   * Remove the object. `missing` is not a failure: the retention sweep is
   * idempotent (CLAUDE.md rule #7) and the bucket's own lifecycle rule may
   * have got there first, so an object that is already gone counts as done.
   */
  delete(loc: RecordingLocation): Promise<'deleted' | 'missing'>;
}

/**
 * Parse the `s3://bucket/key` form SiphonAI stamps on the call. Returns null
 * for anything else, so an unexpected value is "no playback" rather than a
 * malformed URL handed to a browser.
 */
export function parseObjectUri(uri: string): RecordingLocation | null {
  const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri.trim());
  if (!m) return null;
  const [, bucket, key] = m;
  if (!bucket || !key) return null;
  return { bucket, key };
}

export interface S3StorageConfig {
  endpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
  /** Injected so a delete can be exercised without a bucket. */
  fetch?: typeof fetch;
}

/** SHA-256 of an empty body: what a DELETE's payload hashes to. */
const EMPTY_PAYLOAD_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** Percent-encode per RFC 3986, which is stricter than encodeURIComponent. */
function uriEncode(str: string, encodeSlash: boolean): string {
  let out = '';
  for (const ch of Buffer.from(str, 'utf8')) {
    const c = String.fromCharCode(ch);
    if (/[A-Za-z0-9\-._~]/.test(c)) out += c;
    else if (c === '/') out += encodeSlash ? '%2F' : '/';
    else out += `%${ch.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

function hmac(key: crypto.BinaryLike, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

/**
 * The SigV4 signing key: four chained HMACs over secret → date → region →
 * service. Exported because it is the part of the signature with no runtime
 * feedback — a subtle error here is a 403 from the bucket much later — and it
 * can be checked against AWS's published derivation vector.
 */
export function deriveSigningKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secretKey}`, dateStamp), region), service), 'aws4_request');
}

function sha256Hex(data: string): string {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

/**
 * AWS SigV4 against an S3-compatible store, in the two shapes Brayz needs:
 * a presigned GET (the signature travels in the query string, so the URL alone
 * authorizes the fetch — which is exactly what an `<audio>` tag can do and an
 * `Authorization` header cannot) and a header-signed DELETE for the retention
 * sweep, which runs server-side and can send headers like any client.
 */
export class S3RecordingStorage implements RecordingStorage {
  readonly name = 's3';

  constructor(private readonly cfg: S3StorageConfig) {}

  signedUrl(loc: RecordingLocation, ttlSeconds: number, now = new Date()): string {
    const { origin, host, canonicalUri, amzDate, dateStamp, credentialScope } = this.parts(
      loc,
      now,
    );

    // Query parameters must be sorted by name for the canonical request.
    const params: Array<[string, string]> = [
      ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
      ['X-Amz-Credential', `${this.cfg.accessKey}/${credentialScope}`],
      ['X-Amz-Date', amzDate],
      ['X-Amz-Expires', String(Math.max(1, Math.floor(ttlSeconds)))],
      ['X-Amz-SignedHeaders', 'host'],
    ];
    const canonicalQuery = params
      .map(([k, v]) => [uriEncode(k, true), uriEncode(v, true)] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');

    const canonicalRequest = [
      'GET',
      canonicalUri,
      canonicalQuery,
      `host:${host}\n`,
      'host',
      // Presigned GETs carry no body, and S3 accepts the literal marker.
      'UNSIGNED-PAYLOAD',
    ].join('\n');

    const signature = this.sign(canonicalRequest, amzDate, dateStamp, credentialScope);
    return `${origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  }

  async delete(loc: RecordingLocation, now = new Date()): Promise<'deleted' | 'missing'> {
    const { origin, host, canonicalUri, amzDate, dateStamp, credentialScope } = this.parts(
      loc,
      now,
    );

    // Header signing hashes the real (empty) body rather than using the
    // UNSIGNED-PAYLOAD marker, which not every S3-compatible store accepts
    // outside a presigned URL. Canonical headers are sorted by name.
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonicalRequest = [
      'DELETE',
      canonicalUri,
      '',
      `host:${host}\nx-amz-content-sha256:${EMPTY_PAYLOAD_SHA256}\nx-amz-date:${amzDate}\n`,
      signedHeaders,
      EMPTY_PAYLOAD_SHA256,
    ].join('\n');
    const signature = this.sign(canonicalRequest, amzDate, dateStamp, credentialScope);

    const doFetch = this.cfg.fetch ?? fetch;
    const res = await doFetch(`${origin}${canonicalUri}`, {
      method: 'DELETE',
      headers: {
        host,
        'x-amz-content-sha256': EMPTY_PAYLOAD_SHA256,
        'x-amz-date': amzDate,
        authorization:
          `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKey}/${credentialScope}, ` +
          `SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
    });
    if (res.status === 404) return 'missing';
    if (res.ok) return 'deleted';
    const body = await res.text().catch(() => '');
    throw new Error(`recording delete failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }

  /** The pieces both request shapes are built from. */
  private parts(loc: RecordingLocation, now: Date) {
    const url = new URL(this.cfg.endpoint);
    // Path style: works on every S3-compatible store without per-bucket DNS,
    // which a self-hosted MinIO or a fresh GCS bucket will not have.
    const canonicalUri = `/${uriEncode(loc.bucket, true)}/${uriEncode(loc.key, false)}`;
    const amzDate = now
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '');
    const dateStamp = amzDate.slice(0, 8);
    const credentialScope = `${dateStamp}/${this.cfg.region}/s3/aws4_request`;
    return { origin: url.origin, host: url.host, canonicalUri, amzDate, dateStamp, credentialScope };
  }

  private sign(
    canonicalRequest: string,
    amzDate: string,
    dateStamp: string,
    credentialScope: string,
  ): string {
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join('\n');
    const signingKey = deriveSigningKey(this.cfg.secretKey, dateStamp, this.cfg.region, 's3');
    return crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
  }
}

/**
 * Build the configured store, or null when there isn't one. Null is a normal
 * state, not an error: recordings can be switched on at the node before Brayz
 * has credentials to read the bucket, and the dashboard says so rather than
 * pretending the recording is missing.
 */
export function buildRecordingStorage(cfg: {
  RECORDING_S3_ENDPOINT?: string;
  RECORDING_S3_REGION?: string;
  RECORDING_S3_ACCESS_KEY?: string;
  RECORDING_S3_SECRET_KEY?: string;
}): RecordingStorage | null {
  if (!cfg.RECORDING_S3_ENDPOINT || !cfg.RECORDING_S3_ACCESS_KEY || !cfg.RECORDING_S3_SECRET_KEY) {
    return null;
  }
  return new S3RecordingStorage({
    endpoint: cfg.RECORDING_S3_ENDPOINT,
    region: cfg.RECORDING_S3_REGION ?? 'auto',
    accessKey: cfg.RECORDING_S3_ACCESS_KEY,
    secretKey: cfg.RECORDING_S3_SECRET_KEY,
  });
}
