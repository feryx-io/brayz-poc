/**
 * Thin client for services/api. The web app NEVER touches the database directly
 * (CLAUDE.md / plan §3.1) — it always goes through the REST API.
 */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export interface ApiOptions {
  tenantId?: string;
  email?: string;
  method?: string;
  body?: unknown;
}

export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  // Only when there really is a JSON body: Fastify rejects a request that
  // declares `application/json` and then sends nothing, which is every DELETE
  // this client makes.
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.tenantId) headers['x-brayz-tenant-id'] = opts.tenantId;
  if (opts.email) headers['x-brayz-user-email'] = opts.email;

  const res = await fetch(`${API_URL}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    cache: 'no-store',
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw apiError(res.status, path, detail);
  }
  // 204 and other empty replies have no JSON to parse — a delete that worked
  // must not surface as a parse error.
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

/** What the API said no with — status, its error code, and any structured extras (duplicate findings, Zod issues). */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | undefined,
    public readonly body: Record<string, unknown> | undefined,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Build the error a failed API call throws: readable message, structured body kept. */
export function apiError(status: number, path: string, detail: string): ApiError {
  let body: { error?: Record<string, unknown> } | undefined;
  try {
    body = JSON.parse(detail) as { error?: Record<string, unknown> };
  } catch {
    body = undefined;
  }
  const readable = apiErrorMessage(detail) ?? detail ?? `Request failed (${status})`;
  return new ApiError(readable, status, body?.error?.code as string | undefined, body?.error);
}

/**
 * Pull the readable half out of the API's `{ error: { code, message, issues? } }`
 * body. A validation error's bare "Validation failed" says nothing an owner
 * can act on, so the field issues are named: "notificationPhone: Must be an
 * E.164 phone number, e.g. +15185551212".
 */
export function apiErrorMessage(detail: string): string | undefined {
  try {
    const parsed = JSON.parse(detail) as {
      error?: { message?: string; issues?: Array<{ path?: Array<string | number>; message?: string }> };
    };
    const issues = parsed?.error?.issues
      ?.filter((i) => i.message)
      .map((i) => (i.path?.length ? `${i.path.join('.')}: ${i.message}` : i.message))
      .slice(0, 3);
    if (issues?.length) return issues.join('; ');
    return parsed?.error?.message;
  } catch {
    return undefined;
  }
}
