'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { AuthShell, ErrorNote, Field, GoogleButton, OrDivider, SubmitButton } from '@/components/AuthShell';

export default function LoginPage() {
  const { mode, loginDev, loginFirebase, loginGoogle } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'firebase') await loginFirebase(email, password);
      else await loginDev(email);
      router.push('/app/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
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
      title="Sign in"
      subtitle={mode === 'dev' ? 'Restaurant admin portal — dev login.' : 'Welcome back to your restaurant dashboard.'}
      footer={
        <>
          New to Brayz?{' '}
          <Link href="/register" className="font-semibold text-violet-700 hover:text-violet-600">
            Start a free trial
          </Link>
        </>
      }
    >
      {mode === 'firebase' && (
        <>
          <GoogleButton busy={busy} onClick={onGoogle} label="Continue with Google" />
          <OrDivider />
        </>
      )}

      <form className="space-y-4" onSubmit={onSubmit}>
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
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        )}
        {error && <ErrorNote>{error}</ErrorNote>}
        <SubmitButton busy={busy}>{busy ? 'Signing in…' : 'Sign in'}</SubmitButton>
      </form>
    </AuthShell>
  );
}
