import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, type Auth } from 'firebase/auth';

/**
 * Firebase client config. These NEXT_PUBLIC_* values are not secret (they're the
 * public web app config from the Firebase console for the brayz-dev project).
 * Only read when AUTH_MODE is `firebase`.
 */
export const AUTH_MODE = process.env.NEXT_PUBLIC_AUTH_MODE ?? 'dev';

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
};

let app: FirebaseApp | undefined;

export function getFirebaseAuth(): Auth {
  if (!firebaseConfig.apiKey || !firebaseConfig.projectId) {
    throw new Error(
      'Firebase web config missing. Set NEXT_PUBLIC_FIREBASE_API_KEY / _AUTH_DOMAIN / _PROJECT_ID.',
    );
  }
  app ??= getApps()[0] ?? initializeApp(firebaseConfig);
  return getAuth(app);
}

/** Shared Google provider for one-click sign-in. */
export const googleProvider = new GoogleAuthProvider();
