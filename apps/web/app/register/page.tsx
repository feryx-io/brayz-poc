'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { LANDING_TRIAL } from '@/lib/pricing';
import { AuthShell, ErrorNote, Field, GoogleButton, OrDivider, SubmitButton } from '@/components/AuthShell';

/**
 * Account registration. Email/password (+ Google in firebase mode); dev mode is
 * passwordless. Every new account starts on the free trial, which the business
 * the setup wizard creates next is given — so this page says so.
 */
export default function RegisterPage() {
  const { mode, registerDev, registerFirebase, loginGoogle } = useAuth();
  const router = useRouter();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'firebase') await registerFirebase(email, password, displayName);
      else await registerDev(email, displayName);
      router.push('/app/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setBusy(false);
    }
  }

  async function onGoogle() {
    setError(null);
    setBusy(true);
    try {
      await loginGoogle();
      router.push('/app/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title={`Start your ${LANDING_TRIAL.days}-day free trial`}
      subtitle={`Every ${LANDING_TRIAL.planName} feature for ${LANDING_TRIAL.days} days, no credit card. Create your account, then add your restaurant, hours and menu — it takes a few minutes.`}
      footer={
        <>
          Already have an account?{' '}
          <Link href="/login" className="font-semibold text-violet-700 hover:text-violet-600">
            Sign in
          </Link>
        </>
      }
    >
      {mode === 'firebase' && (
        <>
          <GoogleButton busy={busy} onClick={onGoogle} label="Sign up with Google" />
          <OrDivider />
        </>
      )}

      <form className="space-y-4" onSubmit={onSubmit}>
        <Field
          label="Your name"
          type="text"
          required
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Jordan Ferris"
          autoComplete="name"
        />
        <Field
          label="Email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="owner@restaurant.com"
          autoComplete="email"
        />
        {mode === 'firebase' && (
          <Field
            label="Password"
            type="password"
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            hint="At least 6 characters."
          />
        )}
        {error && <ErrorNote>{error}</ErrorNote>}
        <SubmitButton busy={busy}>{busy ? 'Creating account…' : 'Start free trial'}</SubmitButton>
      </form>

      <p className="mt-4 text-xs text-slate-500">
        Not for you? Don’t pick a plan when the trial ends, and you’re never charged.
      </p>

      {mode === 'dev' && (
        <p className="mt-4 text-xs text-slate-500">
          Dev mode: no password. After registering you’ll set up your first restaurant.
        </p>
      )}
    </AuthShell>
  );
}
