'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { API_URL, apiError } from './api';
import { AUTH_MODE, getFirebaseAuth, googleProvider } from './firebase';

export interface Membership {
  tenantId: string;
  tenantName: string;
  role: string;
  locationId: string | null;
}

interface MeUser {
  id: string;
  email: string;
  displayName: string | null;
}

interface MeResponse {
  authenticated: boolean;
  email?: string;
  user?: MeUser | null;
  memberships: Membership[];
  /** Brayz staff only: "support" | "admin". Null for every customer. */
  platformRole?: string | null;
}

interface AuthValue {
  ready: boolean;
  email: string | null;
  displayName: string | null;
  mode: string;
  memberships: Membership[];
  activeTenantId: string | null;
  /** The location all per-location pages operate on (within the active tenant). */
  activeLocationId: string | null;
  setActiveLocation: (id: string | null) => void;
  /** Role in the active tenant, or null. */
  activeRole: string | null;
  /**
   * Brayz staff role, from the server. Only decides whether the admin portal is
   * offered — every /v1/admin route re-checks it, so hiding the link is a
   * courtesy, not the control.
   */
  platformRole: string | null;
  /** True when the active role may edit (owner/manager/admin). */
  canManage: boolean;
  setActiveTenant: (id: string) => void;
  /** Dev mode: verify the account exists, then start the session. Throws if unknown. */
  loginDev: (email: string) => Promise<void>;
  /** Dev mode: create a new account, then start the session. */
  registerDev: (email: string, displayName: string) => Promise<void>;
  loginFirebase: (email: string, password: string) => Promise<void>;
  /** Firebase mode: create an account with email/password + display name. */
  registerFirebase: (email: string, password: string, displayName: string) => Promise<void>;
  /** Firebase mode: one-click Google sign-in (auto-provisions on first use). */
  loginGoogle: () => Promise<void>;
  /** Update the caller's own profile (display name). */
  updateProfile: (displayName: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshMe: () => Promise<void>;
  api: <T>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;
  /** POST multipart/form-data (file uploads) with auth headers. */
  apiForm: <T>(path: string, form: FormData) => Promise<T>;
  /** GET a file (a CSV export) with auth headers; the browser saves the blob. */
  apiBlob: (path: string, opts?: { method?: string; body?: unknown }) => Promise<{ blob: Blob; filename: string | null }>;
}

const AuthContext = createContext<AuthValue | null>(null);

const LS_EMAIL = 'brayz.devEmail';
const LS_TENANT = 'brayz.activeTenantId';
const LS_LOCATION = 'brayz.activeLocationId';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [platformRole, setPlatformRole] = useState<string | null>(null);
  const [activeTenantId, setActiveTenantId] = useState<string | null>(null);
  const [activeLocationId, setActiveLocationId] = useState<string | null>(
    typeof window !== 'undefined' ? localStorage.getItem(LS_LOCATION) : null,
  );
  const tokenRef = useRef<string | null>(null);

  // Build auth headers for the current session/tenant.
  const buildHeaders = useCallback(async (): Promise<Record<string, string>> => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (activeTenantId) headers['x-brayz-tenant-id'] = activeTenantId;
    if (AUTH_MODE === 'firebase') {
      const user = getFirebaseAuth().currentUser;
      if (user) headers.authorization = `Bearer ${await user.getIdToken()}`;
    } else if (email) {
      headers['x-brayz-user-email'] = email;
    }
    return headers;
  }, [activeTenantId, email]);

  const api = useCallback(
    async <T,>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> => {
      const headers = await buildHeaders();
      // No JSON content-type on bodyless requests (DELETE/GET) — otherwise Fastify
      // rejects the empty body with FST_ERR_CTP_EMPTY_JSON_BODY (500).
      if (opts.body === undefined) delete headers['content-type'];
      const res = await fetch(`${API_URL}${path}`, {
        method: opts.method ?? 'GET',
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        cache: 'no-store',
      });
      if (res.status === 204) return undefined as T;
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw apiError(res.status, path, detail);
      }
      return res.json() as Promise<T>;
    },
    [buildHeaders],
  );

  // POST multipart/form-data (file uploads) with auth headers; the browser sets
  // the multipart content-type + boundary, so drop our JSON content-type.
  const apiForm = useCallback(
    async <T,>(path: string, form: FormData): Promise<T> => {
      const headers = await buildHeaders();
      delete headers['content-type'];
      const res = await fetch(`${API_URL}${path}`, { method: 'POST', headers, body: form, cache: 'no-store' });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`API ${res.status} ${path}: ${detail}`);
      }
      return res.json() as Promise<T>;
    },
    [buildHeaders],
  );

  // A download has to carry the same auth headers, which a plain <a href>
  // cannot, so it is fetched and handed to the browser as a blob.
  const apiBlob = useCallback(
    async (path: string, opts: { method?: string; body?: unknown } = {}) => {
      const headers = await buildHeaders();
      if (opts.body === undefined) delete headers['content-type'];
      const res = await fetch(`${API_URL}${path}`, {
        method: opts.method ?? 'GET',
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        cache: 'no-store',
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`API ${res.status} ${path}: ${detail}`);
      }
      const filename = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? null;
      return { blob: await res.blob(), filename };
    },
    [buildHeaders],
  );

  const refreshMe = useCallback(async () => {
    if (!email && AUTH_MODE !== 'firebase') {
      setMemberships([]);
      return;
    }
    try {
      const me = await api<MeResponse>('/v1/me');
      setMemberships(me.memberships ?? []);
      setPlatformRole(me.platformRole ?? null);
      if (me.email) setEmail(me.email);
      let name = me.user?.displayName ?? null;
      // First firebase sign-in: our DB user is provisioned without a name. Sync the
      // provider's display name (Google profile / the name set at email sign-up) once.
      if (AUTH_MODE === 'firebase' && me.user && !name) {
        const fbName = getFirebaseAuth().currentUser?.displayName;
        if (fbName) {
          try {
            const updated = await api<MeUser>('/v1/me', { method: 'PATCH', body: { displayName: fbName } });
            name = updated.displayName ?? null;
          } catch {
            /* non-fatal — name stays unset until edited on the Account page */
          }
        }
      }
      setDisplayName(name);
      // Default the active tenant to the first membership if unset/invalid.
      setActiveTenantId((cur) => {
        const stored = cur ?? (typeof window !== 'undefined' ? localStorage.getItem(LS_TENANT) : null);
        const valid = me.memberships?.find((m) => m.tenantId === stored);
        return valid?.tenantId ?? me.memberships?.[0]?.tenantId ?? null;
      });
    } catch {
      setMemberships([]);
      setPlatformRole(null);
    }
  }, [api, email]);

  // Bootstrap session on mount.
  useEffect(() => {
    let cancelled = false;
    async function boot() {
      if (AUTH_MODE === 'firebase') {
        const { onAuthStateChanged } = await import('firebase/auth');
        onAuthStateChanged(getFirebaseAuth(), async (user) => {
          if (cancelled) return;
          setEmail(user?.email ?? null);
          tokenRef.current = user ? await user.getIdToken() : null;
          setReady(true);
        });
      } else {
        const stored = typeof window !== 'undefined' ? localStorage.getItem(LS_EMAIL) : null;
        if (stored) setEmail(stored);
        setReady(true);
      }
    }
    void boot();
    return () => {
      cancelled = true;
    };
  }, []);

  // Whenever identity changes, (re)load memberships.
  useEffect(() => {
    if (ready) void refreshMe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, email]);

  // Persist active tenant.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (activeTenantId) localStorage.setItem(LS_TENANT, activeTenantId);
  }, [activeTenantId]);

  // Persist active location.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (activeLocationId) localStorage.setItem(LS_LOCATION, activeLocationId);
    else localStorage.removeItem(LS_LOCATION);
  }, [activeLocationId]);

  // Switching tenants clears the active location — the layout reconciles it to
  // the new tenant's first location once its locations load.
  const setActiveTenant = useCallback((id: string) => {
    setActiveTenantId(id);
    setActiveLocationId(null);
  }, []);
  const setActiveLocation = useCallback((id: string | null) => setActiveLocationId(id), []);

  const loginDev = useCallback(async (devEmail: string) => {
    // Verify the account exists before starting a session — unlike register,
    // login must not silently create a brand-new empty account.
    const res = await fetch(`${API_URL}/v1/me`, {
      headers: { 'x-brayz-user-email': devEmail },
      cache: 'no-store',
    });
    const me = (await res.json().catch(() => null)) as MeResponse | null;
    if (!me?.user) {
      throw new Error('No account found for this email. Register first.');
    }
    localStorage.setItem(LS_EMAIL, devEmail);
    setEmail(devEmail);
  }, []);

  const registerDev = useCallback(async (newEmail: string, name: string) => {
    const res = await fetch(`${API_URL}/v1/auth/dev/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: newEmail, displayName: name }),
    });
    if (res.status === 409) {
      throw new Error('An account with this email already exists. Log in instead.');
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Could not register: ${detail || res.status}`);
    }
    localStorage.setItem(LS_EMAIL, newEmail);
    setEmail(newEmail);
  }, []);

  const updateProfile = useCallback(
    async (name: string) => {
      const updated = await api<MeUser>('/v1/me', { method: 'PATCH', body: { displayName: name } });
      setDisplayName(updated.displayName ?? null);
    },
    [api],
  );

  const loginFirebase = useCallback(async (e: string, password: string) => {
    const { signInWithEmailAndPassword } = await import('firebase/auth');
    await signInWithEmailAndPassword(getFirebaseAuth(), e, password);
  }, []);

  const registerFirebase = useCallback(
    async (e: string, password: string, name: string) => {
      const { createUserWithEmailAndPassword, updateProfile: fbUpdateProfile } = await import(
        'firebase/auth'
      );
      const cred = await createUserWithEmailAndPassword(getFirebaseAuth(), e, password);
      await fbUpdateProfile(cred.user, { displayName: name });
      // Provision our DB user + sync the name (refreshMe handles both); the
      // onAuthStateChanged listener also fires, but call it directly so the name is
      // persisted promptly now that the firebase profile carries it.
      setEmail(cred.user.email ?? e);
      await refreshMe();
    },
    [refreshMe],
  );

  const loginGoogle = useCallback(async () => {
    const { signInWithPopup } = await import('firebase/auth');
    await signInWithPopup(getFirebaseAuth(), googleProvider);
    // onAuthStateChanged → refreshMe provisions the user and syncs the Google name.
  }, []);

  const logout = useCallback(async () => {
    if (AUTH_MODE === 'firebase') {
      const { signOut } = await import('firebase/auth');
      await signOut(getFirebaseAuth());
    }
    localStorage.removeItem(LS_EMAIL);
    setEmail(null);
    setDisplayName(null);
    setMemberships([]);
    setActiveTenantId(null);
  }, []);

  const activeRole = memberships.find((m) => m.tenantId === activeTenantId)?.role ?? null;
  const canManage = !!activeRole && ['owner', 'manager', 'admin'].includes(activeRole);

  const value = useMemo<AuthValue>(
    () => ({
      ready,
      email,
      displayName,
      mode: AUTH_MODE,
      memberships,
      activeTenantId,
      activeLocationId,
      setActiveLocation,
      activeRole,
      canManage,
      platformRole,
      setActiveTenant,
      loginDev,
      registerDev,
      loginFirebase,
      registerFirebase,
      loginGoogle,
      updateProfile,
      logout,
      refreshMe,
      api,
      apiForm,
      apiBlob,
    }),
    [ready, email, displayName, memberships, activeTenantId, activeLocationId, setActiveLocation, activeRole, canManage, platformRole, setActiveTenant, loginDev, registerDev, loginFirebase, registerFirebase, loginGoogle, updateProfile, logout, refreshMe, api, apiForm, apiBlob],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}
