'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Radio, Lock, CheckCircle2, AlertCircle, AlertTriangle, ArrowLeft, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { isRecoverySessionToken } from '@/lib/auth/session';
import { normalizeAuthError } from '@/lib/auth/errors';

export default function ResetPasswordPage() {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Recovery session state: null = checking, true = verified recovery, false = invalid/ordinary session
  const [isRecoveryValid, setIsRecoveryValid] = useState<boolean | null>(null);
  const [isCheckingSession, setIsCheckingSession] = useState(true);

  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    async function verifyRecoverySession() {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();

        if (!session?.access_token) {
          setIsRecoveryValid(false);
          setErrorMessage('Password reset link has expired, is invalid, or was already used. Please request a new link.');
          return;
        }

        // Enforce Invariant AUTH-STATE-001 / SEC3-11:
        // Inspect verified AMR claims in JWT. Only sessions created via password recovery may use this page.
        const isRecovery = isRecoverySessionToken(session.access_token);
        if (!isRecovery) {
          setIsRecoveryValid(false);
          setErrorMessage('Invalid session type. Password reset requires an authentic recovery link from your email.');
          return;
        }

        setIsRecoveryValid(true);
      } catch (err) {
        setIsRecoveryValid(false);
        setErrorMessage('Failed to verify recovery session state.');
      } finally {
        setIsCheckingSession(false);
      }
    }

    verifyRecoverySession();
  }, [supabase]);

  const handleUpdatePassword = async (e: React.FormEvent) => {
    e.preventDefault();

    if (password !== confirmPassword) {
      setErrorMessage('Passwords do not match. Please try again.');
      return;
    }

    // Invariant AUTH-PASSWORD-001: Consistent minimum 8 characters across all surfaces
    if (password.length < 8) {
      setErrorMessage('Password must be at least 8 characters long.');
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);

    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) {
        const normalized = normalizeAuthError(error, 'reset_password');
        setErrorMessage(normalized.safeUserMessage);
      } else {
        setIsSuccess(true);
        // Safely terminate recovery session state before navigating to login
        try {
          await supabase.auth.signOut({ scope: 'local' });
        } catch {
          // Ignore local signout error
        }
        setTimeout(() => {
          router.push('/login?message=password_updated');
        }, 1500);
      }
    } catch (err: any) {
      const normalized = normalizeAuthError(err, 'reset_password');
      setErrorMessage(normalized.safeUserMessage);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col justify-center items-center p-4 antialiased">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <div className="inline-flex p-3 rounded-2xl bg-gradient-to-tr from-blue-600 via-indigo-600 to-cyan-500 text-white shadow-xl shadow-blue-500/20 mb-2">
            <Radio className="w-7 h-7 animate-pulse" />
          </div>
          <h1 className="text-2xl font-bold text-slate-100 tracking-tight flex items-center justify-center gap-2">
            <span>VoIP Hub</span>
            <Badge variant="blue" size="sm">
              NEW PASSWORD
            </Badge>
          </h1>
        </div>

        <Card className="p-6 space-y-5 shadow-2xl border-slate-800/80 bg-slate-900/80 backdrop-blur-xl">
          {isCheckingSession ? (
            <div className="py-8 flex flex-col items-center justify-center space-y-3 text-slate-400">
              <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
              <p className="text-xs">Verifying recovery session authority...</p>
            </div>
          ) : isRecoveryValid === false ? (
            <div className="text-center py-4 space-y-4">
              <div className="w-12 h-12 rounded-2xl bg-amber-500/10 text-amber-400 border border-amber-500/20 flex items-center justify-center mx-auto">
                <AlertTriangle className="w-6 h-6" />
              </div>
              <div className="space-y-1.5">
                <h2 className="text-base font-bold text-slate-100">Recovery Session Required</h2>
                <p className="text-xs text-slate-400 max-w-xs mx-auto leading-relaxed">
                  {errorMessage || 'This page is strictly reserved for password recovery via a verified email recovery link. Ordinary authenticated sessions cannot change passwords here.'}
                </p>
              </div>
              <div className="pt-2 space-y-2">
                <Link
                  href="/forgot-password"
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-lg shadow-blue-600/20 transition-all"
                >
                  Request Password Reset Link
                </Link>
                <div>
                  <Link
                    href="/login"
                    className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors font-medium mt-1"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" />
                    <span>Return to Sign In</span>
                  </Link>
                </div>
              </div>
            </div>
          ) : !isSuccess ? (
            <>
              <div className="space-y-1 border-b border-slate-800 pb-3">
                <h2 className="text-base font-semibold text-slate-100">Set New Password</h2>
                <p className="text-xs text-slate-400">Enter a new secure password for your workspace account.</p>
              </div>

              {errorMessage && (
                <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs flex items-start gap-2.5">
                  <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                  <div>{errorMessage}</div>
                </div>
              )}

              <form onSubmit={handleUpdatePassword} className="space-y-4">
                <div>
                  <label className="text-xs font-semibold text-slate-300 block mb-1.5">New Password</label>
                  <Input
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••••••"
                    icon={<Lock className="w-4 h-4" />}
                  />
                  <p className="text-[11px] text-slate-500 mt-1">Must be at least 8 characters long.</p>
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-300 block mb-1.5">Confirm New Password</label>
                  <Input
                    type="password"
                    required
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="••••••••••••"
                    icon={<Lock className="w-4 h-4" />}
                  />
                </div>

                <Button type="submit" variant="primary" size="lg" className="w-full py-3 font-semibold" isLoading={isLoading}>
                  Update Password
                </Button>
              </form>
            </>
          ) : (
            <div className="text-center py-4 space-y-3">
              <div className="inline-flex p-3 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 mb-2">
                <CheckCircle2 className="w-8 h-8" />
              </div>
              <h2 className="text-base font-bold text-slate-100">Password Updated Successfully</h2>
              <p className="text-xs text-slate-400">Redirecting to sign in page...</p>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
