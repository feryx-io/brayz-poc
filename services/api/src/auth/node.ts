import type { FastifyRequest } from 'fastify';
import { loadConfig } from '@brayz/config';
import { unauthorized } from '../lib/http.js';

/**
 * Authenticates internal voice-plane callers (Siphon-AI nodes, the Orchestrator)
 * via the shared node secret. MVP uses a constant-time compare of a bearer/secret
 * header against BRAYZ_NODE_SHARED_SECRET; the plan upgrades this to mTLS / signed
 * node tokens later. These callers are NOT tenant-scoped — they operate across
 * tenants and resolve scope from the called number.
 */
export function requireNode(request: FastifyRequest): void {
  const cfg = loadConfig();
  const provided =
    headerSecret(request, 'x-brayz-node-secret') ?? bearer(request);
  if (!provided || !timingSafeEqual(provided, cfg.BRAYZ_NODE_SHARED_SECRET)) {
    throw unauthorized('Invalid or missing node credential');
  }
}

function headerSecret(request: FastifyRequest, name: string): string | undefined {
  const v = request.headers[name];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function bearer(request: FastifyRequest): string | undefined {
  const h = request.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7).trim() || undefined : undefined;
}

/** Length-safe, constant-time string comparison. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}
