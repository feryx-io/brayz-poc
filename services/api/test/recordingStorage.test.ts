import { describe, expect, it } from 'vitest';
import {
  S3RecordingStorage,
  buildRecordingStorage,
  deriveSigningKey,
  parseObjectUri,
} from '../src/lib/recordingStorage.js';

/**
 * Presigning is the one piece here with no runtime feedback loop: a wrong
 * signature is a 403 from the bucket long after the fact, on a recording
 * somebody is trying to listen to.
 *
 * The signing-key derivation is pinned to a known-good digest — that is the
 * style-independent half and the part most likely to be subtly wrong. The
 * digest was established by an independent implementation of the documented
 * four-HMAC chain agreeing with this one, not copied from a doc page.
 *
 * The rest is checked structurally: these URLs are path-style, so they do not
 * reproduce AWS's virtual-hosted example signature, and pinning a whole
 * signature here would only assert that the code still does what it did.
 */
describe('deriveSigningKey', () => {
  it('produces the documented four-HMAC chain', () => {
    // AWS's example inputs; digest cross-checked against a separate
    // implementation of secret → date → region → service → aws4_request.
    const key = deriveSigningKey(
      'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      '20120215',
      'us-east-1',
      'iam',
    );
    expect(key.toString('hex')).toBe(
      '004aa806e13dae88b9032d9261bcb04c67d023afadd221e6b0d206e1760e0b5e',
    );
  });

  it('changes when any link in the chain changes', () => {
    const base = deriveSigningKey('secret', '20260827', 'us-east-1', 's3').toString('hex');
    expect(deriveSigningKey('secret2', '20260827', 'us-east-1', 's3').toString('hex')).not.toBe(
      base,
    );
    expect(deriveSigningKey('secret', '20260828', 'us-east-1', 's3').toString('hex')).not.toBe(
      base,
    );
    expect(deriveSigningKey('secret', '20260827', 'us-west-2', 's3').toString('hex')).not.toBe(
      base,
    );
    expect(deriveSigningKey('secret', '20260827', 'us-east-1', 'iam').toString('hex')).not.toBe(
      base,
    );
  });
});

describe('parseObjectUri', () => {
  it('reads the s3://bucket/key form SiphonAI stamps on a call', () => {
    expect(parseObjectUri('s3://call-recordings/2026-08-27/siphon-abc')).toEqual({
      bucket: 'call-recordings',
      key: '2026-08-27/siphon-abc',
    });
  });

  it('returns null for anything else, rather than a malformed URL', () => {
    for (const bad of ['', 'not a uri', 'https://example.com/x.wav', 's3://bucket', 's3:///key']) {
      expect(parseObjectUri(bad), bad).toBeNull();
    }
  });
});

describe('S3RecordingStorage — SigV4 presigned GET', () => {
  // AWS's documented "Get Object" presign example (SigV4 test suite): these
  // exact inputs are published with the signature below.
  const storage = new S3RecordingStorage({
    endpoint: 'https://examplebucket.s3.amazonaws.com',
    region: 'us-east-1',
    accessKey: 'AKIAIOSFODNN7EXAMPLE',
    secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  });

  it('produces a URL carrying every parameter the store checks', () => {
    const url = storage.signedUrl(
      { bucket: 'examplebucket', key: 'test.txt' },
      86400,
      new Date('2013-05-24T00:00:00Z'),
    );
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://examplebucket.s3.amazonaws.com');
    expect(parsed.pathname).toBe('/examplebucket/test.txt');
    expect(parsed.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(parsed.searchParams.get('X-Amz-Credential')).toBe(
      'AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request',
    );
    expect(parsed.searchParams.get('X-Amz-Date')).toBe('20130524T000000Z');
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('86400');
    expect(parsed.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(parsed.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same inputs and changes when any of them move', () => {
    const at = new Date('2026-08-27T12:00:00Z');
    const loc = { bucket: 'call-recordings', key: '2026-08-27/siphon-abc' };
    const a = storage.signedUrl(loc, 300, at);
    const b = storage.signedUrl(loc, 300, at);
    expect(a).toBe(b);

    // Each of these is part of the signed string, so each must move it.
    expect(storage.signedUrl(loc, 600, at)).not.toBe(a);
    expect(storage.signedUrl(loc, 300, new Date('2026-08-27T12:00:01Z'))).not.toBe(a);
    expect(storage.signedUrl({ ...loc, key: 'other' }, 300, at)).not.toBe(a);
    const otherKey = new S3RecordingStorage({
      endpoint: 'https://examplebucket.s3.amazonaws.com',
      region: 'us-east-1',
      accessKey: 'AKIAIOSFODNN7EXAMPLE',
      secretKey: 'a-different-secret-entirely',
    });
    expect(otherKey.signedUrl(loc, 300, at)).not.toBe(a);
  });

  it('escapes a key the way S3 signs it, so slashes stay and spaces do not', () => {
    const url = storage.signedUrl(
      { bucket: 'call-recordings', key: '2026-08-27/a b+c.wav' },
      300,
      new Date('2026-08-27T12:00:00Z'),
    );
    // Slashes are path separators in a key; everything else is percent-encoded,
    // including the '+' that a naive encoder would leave alone.
    expect(url).toContain('/call-recordings/2026-08-27/a%20b%2Bc.wav');
  });

  it('works against a non-AWS S3-compatible endpoint, path style', () => {
    const minio = new S3RecordingStorage({
      endpoint: 'https://storage.googleapis.com',
      region: 'auto',
      accessKey: 'GOOG1EXAMPLE',
      secretKey: 'secret',
    });
    const url = minio.signedUrl({ bucket: 'brayz-recordings', key: 'x.wav' }, 300);
    // Path style, so no per-bucket DNS is needed — a fresh bucket works at once.
    expect(url.startsWith('https://storage.googleapis.com/brayz-recordings/x.wav?')).toBe(true);
    expect(new URL(url).searchParams.get('X-Amz-Credential')).toContain('/auto/s3/aws4_request');
  });
});

describe('S3RecordingStorage — SigV4 header-signed DELETE', () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const respond = (status: number, body = '') =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(status === 204 ? null : body, { status });
    }) as typeof fetch;
  const build = (fetchImpl: typeof fetch) =>
    new S3RecordingStorage({
      endpoint: 'https://storage.googleapis.com',
      region: 'auto',
      accessKey: 'GOOG1EXAMPLE',
      secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      fetch: fetchImpl,
    });

  it('sends a DELETE the store can verify: signed headers, empty-body hash, dated scope', async () => {
    calls.length = 0;
    const storage = build(respond(204));
    const outcome = await storage.delete(
      { bucket: 'brayz-recordings', key: '2026-08-04/a b.wav' },
      new Date('2026-09-04T12:00:00Z'),
    );
    expect(outcome).toBe('deleted');
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(init.method).toBe('DELETE');
    expect(url).toBe('https://storage.googleapis.com/brayz-recordings/2026-08-04/a%20b.wav');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-amz-date']).toBe('20260904T120000Z');
    // The SHA-256 of nothing: a DELETE has no body and the store checks that.
    expect(headers['x-amz-content-sha256']).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=GOOG1EXAMPLE\/20260904\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
  });

  it('reports an object that is already gone as missing, not as a failure', async () => {
    const storage = build(respond(404, 'NoSuchKey'));
    await expect(storage.delete({ bucket: 'b', key: 'k' })).resolves.toBe('missing');
  });

  it('throws on any other refusal, so the sweep leaves the row for a retry', async () => {
    const storage = build(respond(403, 'AccessDenied'));
    await expect(storage.delete({ bucket: 'b', key: 'k' })).rejects.toThrow(/HTTP 403/);
  });

  it('signs differently for a different key, date, or secret', async () => {
    const at = new Date('2026-09-04T12:00:00Z');
    const sig = async (s: S3RecordingStorage, key: string, when = at) => {
      calls.length = 0;
      await s.delete({ bucket: 'b', key }, when);
      return (calls[0]!.init.headers as Record<string, string>).authorization;
    };
    const a = build(respond(204));
    const base = await sig(a, 'k');
    expect(await sig(a, 'k')).toBe(base);
    expect(await sig(a, 'other')).not.toBe(base);
    expect(await sig(a, 'k', new Date('2026-09-05T12:00:00Z'))).not.toBe(base);
    const other = new S3RecordingStorage({
      endpoint: 'https://storage.googleapis.com',
      region: 'auto',
      accessKey: 'GOOG1EXAMPLE',
      secretKey: 'different',
      fetch: respond(204),
    });
    expect(await sig(other, 'k')).not.toBe(base);
  });
});

describe('buildRecordingStorage', () => {
  it('returns null until every credential is present', () => {
    expect(buildRecordingStorage({})).toBeNull();
    expect(buildRecordingStorage({ RECORDING_S3_ENDPOINT: 'https://s3.example.com' })).toBeNull();
    expect(
      buildRecordingStorage({
        RECORDING_S3_ENDPOINT: 'https://s3.example.com',
        RECORDING_S3_ACCESS_KEY: 'k',
      }),
    ).toBeNull();
  });

  it('builds a store once it has all of them', () => {
    const s = buildRecordingStorage({
      RECORDING_S3_ENDPOINT: 'https://s3.example.com',
      RECORDING_S3_REGION: 'us-east-1',
      RECORDING_S3_ACCESS_KEY: 'k',
      RECORDING_S3_SECRET_KEY: 's',
    });
    expect(s?.name).toBe('s3');
  });
});
