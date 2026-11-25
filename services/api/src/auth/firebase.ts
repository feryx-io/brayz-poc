import type { FastifyRequest } from 'fastify';

/** Identity resolved from a verified credential. */
export interface VerifiedIdentity {
  subject: string; // stable provider user id (Firebase uid)
  email?: string;
  // True when the provider has verified the email (Google always; email/password
  // only after verification). Gates linking to a pre-existing account by email.
  emailVerified: boolean;
}

export interface AuthVerifier {
  readonly mode: string;
  /** Verify the request's credential; return null if none/invalid. */
  verify(request: FastifyRequest): Promise<VerifiedIdentity | null>;
}

/**
 * Verifies Firebase / Identity Platform ID tokens. `verifyIdToken` validates the
 * signature against Google's public certs and checks the audience equals the
 * project id — so no service-account secret is needed in the API just to verify.
 * firebase-admin is imported lazily so dev/test runs never load it.
 */
export class FirebaseAuthVerifier implements AuthVerifier {
  readonly mode = 'firebase';
  private authPromise?: Promise<import('firebase-admin/auth').Auth>;

  constructor(private readonly projectId: string) {}

  private getAuth() {
    if (!this.authPromise) {
      this.authPromise = (async () => {
        const { initializeApp, getApps } = await import('firebase-admin/app');
        const { getAuth } = await import('firebase-admin/auth');
        const app = getApps()[0] ?? initializeApp({ projectId: this.projectId });
        return getAuth(app);
      })();
    }
    return this.authPromise;
  }

  async verify(request: FastifyRequest): Promise<VerifiedIdentity | null> {
    const header = request.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) return null;
    const token = header.slice('Bearer '.length).trim();
    if (!token) return null;
    try {
      const auth = await this.getAuth();
      const decoded = await auth.verifyIdToken(token);
      return { subject: decoded.uid, email: decoded.email, emailVerified: decoded.email_verified === true };
    } catch (err) {
      request.log.warn({ err }, 'Firebase ID token verification failed');
      return null;
    }
  }
}
