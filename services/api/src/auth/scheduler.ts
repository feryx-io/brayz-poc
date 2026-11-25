import type { FastifyRequest } from 'fastify';
import { loadConfig } from '@brayz/config';
import { unauthorized } from '../lib/http.js';
import { requireNode } from './node.js';

/**
 * Authenticates a scheduled internal job — today the recording-retention
 * sweep, invoked by Cloud Scheduler.
 *
 * The API's Cloud Run service is public (the dashboard and the Orchestrator
 * call it), so Cloud Run does not check the caller and the API has to. Two
 * credentials are accepted:
 *
 * - **A Google OIDC identity token** from the scheduler's own service
 *   account. Cloud Scheduler mints one per invocation, signed by Google, with
 *   the audience we configure. No shared secret lives in the job definition
 *   or Terraform state. Only accepted when both `SCHEDULER_INVOKER_EMAIL` and
 *   `SCHEDULER_OIDC_AUDIENCE` are set — an audience that any Google-signed
 *   token would satisfy is no check at all, so it fails closed.
 * - **The node secret**, which is how the endpoint is exercised locally, in
 *   tests, and by an operator with curl. The job it gates is idempotent and
 *   policy-driven — whoever triggers it, only recordings past their location's
 *   retention are removed — so the secret guards against nuisance, not
 *   escalation.
 */
export interface OidcVerifier {
  /** Resolve the verified email for an identity token, or null. */
  verify(idToken: string, audience: string): Promise<{ email: string; emailVerified: boolean } | null>;
}

/** Verifies Google-signed ID tokens against Google's published certs. */
export class GoogleOidcVerifier implements OidcVerifier {
  private clientPromise?: Promise<import('google-auth-library').OAuth2Client>;

  private getClient() {
    if (!this.clientPromise) {
      // Lazy: dev and test runs never need the library loaded.
      this.clientPromise = import('google-auth-library').then((m) => new m.OAuth2Client());
    }
    return this.clientPromise;
  }

  async verify(idToken: string, audience: string) {
    const client = await this.getClient();
    const ticket = await client.verifyIdToken({ idToken, audience });
    const payload = ticket.getPayload();
    if (!payload?.email) return null;
    return { email: payload.email, emailVerified: payload.email_verified === true };
  }
}

export interface SchedulerAuthOptions {
  verifier?: OidcVerifier;
}

export function makeRequireScheduler(opts: SchedulerAuthOptions = {}) {
  const verifier = opts.verifier ?? new GoogleOidcVerifier();

  return async function requireScheduler(request: FastifyRequest): Promise<void> {
    // The node secret is checked first because it is a constant-time compare
    // and needs no network; a mismatch is not an error yet, just "not that".
    try {
      requireNode(request);
      return;
    } catch {
      /* fall through to OIDC */
    }

    const cfg = loadConfig();
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token || !cfg.SCHEDULER_INVOKER_EMAIL || !cfg.SCHEDULER_OIDC_AUDIENCE) {
      throw unauthorized('Invalid or missing scheduler credential');
    }

    let identity: Awaited<ReturnType<OidcVerifier['verify']>>;
    try {
      identity = await verifier.verify(token, cfg.SCHEDULER_OIDC_AUDIENCE);
    } catch (err) {
      request.log.warn({ err }, 'scheduler OIDC token verification failed');
      identity = null;
    }
    if (
      !identity ||
      !identity.emailVerified ||
      identity.email.toLowerCase() !== cfg.SCHEDULER_INVOKER_EMAIL.toLowerCase()
    ) {
      throw unauthorized('Invalid or missing scheduler credential');
    }
  };
}
