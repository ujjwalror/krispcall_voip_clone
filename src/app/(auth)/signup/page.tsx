'use client';

import React, { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Lock, Mail, User, AlertCircle, Eye, EyeOff, Radio, ArrowRight, CheckCircle2, Users } from 'lucide-react';
import Link from 'next/link';

const GoogleIcon = () => (
  <svg className="w-4 h-4 mr-2" viewBox="0 0 24 24">
    <path
      fill="#4285F4"
      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
    />
    <path
      fill="#34A853"
      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
    />
    <path
      fill="#FBBC05"
      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
    />
    <path
      fill="#EA4335"
      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
    />
  </svg>
);

interface InvitationInfo {
  id: string;
  email: string;
  role: string;
  organizationName: string;
  organizationSlug: string;
}

function SignupContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tokenParam = searchParams.get('token');
  const supabase = createClient();

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Invitation State
  const [invitationInfo, setInvitationInfo] = useState<InvitationInfo | null>(null);
  const [isVerifyingInvite, setIsVerifyingInvite] = useState(false);

  // 1. Detect and verify invitation token from URL
  useEffect(() => {
    if (!tokenParam || tokenParam.trim() === '') return;

    async function verifyInvite() {
      setIsVerifyingInvite(true);
      try {
        const res = await fetch(`/api/invitations/verify?token=${encodeURIComponent(tokenParam!)}`);
        const data = await res.json();
        if (res.ok && data.invitation) {
          setInvitationInfo(data.invitation);
          setEmail(data.invitation.email); // Prefill & lock email address
        } else {
          setErrorMessage(data.error || 'Invalid or expired invitation link.');
        }
      } catch (err) {
        console.error('[SignupPage] Verification fetch error:', err);
        setErrorMessage('Failed to verify invitation link.');
      } finally {
        setIsVerifyingInvite(false);
      }
    }

    verifyInvite();
  }, [tokenParam]);

  const isInviteMode = Boolean(tokenParam && invitationInfo);

  // Google OAuth Registration / Authentication
  const handleGoogleSignup = async () => {
    setIsGoogleLoading(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      // Preserve invitation context through OAuth callback
      const callbackNext = isInviteMode && tokenParam
        ? `/invite/accept?token=${encodeURIComponent(tokenParam)}`
        : '/dashboard';

      const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(callbackNext)}`;

      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo,
        },
      });

      if (error) {
        setErrorMessage(error.message);
        setIsGoogleLoading(false);
      }
    } catch (err: any) {
      setErrorMessage('Failed to initiate Google sign up. Please try again.');
      setIsGoogleLoading(false);
    }
  };

  // Email/Password Registration
  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    if (password !== confirmPassword) {
      setErrorMessage('Passwords do not match. Please verify your passwords.');
      setIsLoading(false);
      return;
    }

    if (password.length < 8) {
      setErrorMessage('Password must be at least 8 characters long.');
      setIsLoading(false);
      return;
    }

    try {
      const targetEmail = isInviteMode && invitationInfo ? invitationInfo.email : email;

      // 1. Invoke Supabase Auth signUp
      const { data, error } = await supabase.auth.signUp({
        email: targetEmail,
        password,
        options: {
          data: {
            full_name: fullName,
          },
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
      });

      if (error) {
        setErrorMessage(error.message);
        setIsLoading(false);
        return;
      }

      if (data.user) {
        // Automatically attempt sign in if email confirmation is disabled/auto-confirmed
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: targetEmail,
          password,
        });

        if (signInError) {
          setSuccessMessage('Account created! Please check your email to confirm your account before signing in.');
          setIsLoading(false);
          return;
        }

        // If in invitation mode, redirect to invitation acceptance screen
        if (isInviteMode && tokenParam) {
          router.push(`/invite/accept?token=${encodeURIComponent(tokenParam)}`);
          router.refresh();
          return;
        }

        // Check if user already has a profile
        const { data: profile } = await supabase
          .from('profiles')
          .select('id')
          .eq('id', data.user.id)
          .maybeSingle();

        if (profile) {
          router.push('/dashboard');
        } else {
          router.push('/onboarding');
        }
        router.refresh();
      }
    } catch (err: any) {
      setErrorMessage('An unexpected error occurred during registration. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const isAnyLoading = isLoading || isGoogleLoading || isVerifyingInvite;

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col justify-center py-12 sm:px-6 lg:px-8 text-slate-100 relative overflow-hidden">
      {/* Background glow accents */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-blue-600/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-1/4 right-1/4 w-80 h-80 bg-indigo-600/10 rounded-full blur-3xl pointer-events-none" />

      {/* Header Wording */}
      <div className="sm:mx-auto sm:w-full sm:max-w-md text-center space-y-3 z-10">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs font-medium">
          <Radio className="w-3.5 h-3.5 animate-pulse" />
          <span>VoIP Hub Commercial SaaS</span>
        </div>
        
        <h1 className="text-2xl font-bold tracking-tight text-white">
          {isInviteMode && invitationInfo
            ? 'Create Your Account'
            : 'Create Your SaaS Workspace Account'}
        </h1>
        <p className="text-xs text-slate-400">
          {isInviteMode && invitationInfo
            ? `Create your account to join ${invitationInfo.organizationName}.`
            : 'Get started with multi-tenant business voice, messaging, and CRM integrations.'}
        </p>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md z-10">
        <Card className="p-6 space-y-5 shadow-2xl border-slate-800/80 bg-slate-900/80 backdrop-blur-xl">
          {/* Card Title */}
          <div className="space-y-1 border-b border-slate-800 pb-3">
            <h2 className="text-base font-semibold text-slate-100">
              {isInviteMode && invitationInfo
                ? `Join ${invitationInfo.organizationName}`
                : 'Create Account'}
            </h2>
            <p className="text-xs text-slate-400">
              {isInviteMode && invitationInfo
                ? `You've been invited as ${invitationInfo.role.toUpperCase()}.`
                : 'Enter your details to create your workspace account.'}
            </p>
          </div>

          {/* Invitation Context Panel */}
          {isInviteMode && invitationInfo && (
            <div className="p-3.5 rounded-xl bg-purple-950/20 border border-purple-800/40 text-xs space-y-1.5 font-mono">
              <div className="flex items-center justify-between text-[11px] text-purple-300 font-bold">
                <div className="flex items-center gap-1.5">
                  <Users className="w-3.5 h-3.5" />
                  <span>WORKSPACE INVITATION</span>
                </div>
                <Badge variant="purple" size="sm">{invitationInfo.role.toUpperCase()}</Badge>
              </div>
              <div className="text-slate-300 text-xs">
                <span className="text-slate-400">Workspace:</span> <strong>{invitationInfo.organizationName}</strong>
              </div>
              <div className="text-slate-300 text-xs">
                <span className="text-slate-400">Invited Email:</span> <strong className="text-purple-300">{invitationInfo.email}</strong>
              </div>
            </div>
          )}

          {errorMessage && (
            <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs flex items-start gap-2.5 animate-in fade-in duration-150">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <div className="leading-relaxed">{errorMessage}</div>
            </div>
          )}

          {successMessage && (
            <div className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-xs flex items-start gap-2.5 animate-in fade-in duration-150">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <div className="leading-relaxed">{successMessage}</div>
            </div>
          )}

          {/* 1. Continue with Google */}
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="w-full py-3 text-sm font-semibold bg-slate-800/90 hover:bg-slate-800 text-slate-100 border-slate-700 flex items-center justify-center transition-all shadow-sm"
            onClick={handleGoogleSignup}
            isLoading={isGoogleLoading}
            disabled={isAnyLoading && !isGoogleLoading}
          >
            <GoogleIcon />
            <span>Continue with Google</span>
          </Button>

          {/* 2. Visual Divider */}
          <div className="relative my-2">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-slate-800" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-slate-900/90 px-2 text-slate-400 font-medium tracking-wider">OR</span>
            </div>
          </div>

          <form onSubmit={handleSignup} className="space-y-4">
            <div>
              <label className="text-xs font-semibold text-slate-300 block mb-1.5">Full Name</label>
              <Input
                type="text"
                required
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Jane Smith"
                icon={<User className="w-4 h-4" />}
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-semibold text-slate-300">
                  {isInviteMode ? 'Invited Email Address (Locked)' : 'Work Email Address'}
                </label>
                {isInviteMode && (
                  <span className="text-[10px] text-purple-400 font-mono font-semibold">🔒 Invitation Target</span>
                )}
              </div>
              <Input
                type="email"
                required
                value={email}
                onChange={(e) => !isInviteMode && setEmail(e.target.value)}
                readOnly={isInviteMode}
                placeholder="jane@company.com"
                icon={<Mail className="w-4 h-4" />}
                className={isInviteMode ? "opacity-85 cursor-not-allowed bg-slate-950 font-mono text-purple-300" : ""}
              />
            </div>

            <div>
              <label className="text-xs font-semibold text-slate-300 block mb-1.5">Password</label>
              <Input
                type={showPassword ? 'text' : 'password'}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
                icon={<Lock className="w-4 h-4" />}
                rightElement={
                  <button
                    type="button"
                    onClick={() => setShowPassword((prev) => !prev)}
                    className="text-slate-400 hover:text-slate-200 transition-colors p-1 rounded-md focus:outline-none focus:text-slate-200"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                }
              />
            </div>

            <div>
              <label className="text-xs font-semibold text-slate-300 block mb-1.5">Confirm Password</label>
              <Input
                type={showPassword ? 'text' : 'password'}
                required
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="••••••••••••"
                icon={<Lock className="w-4 h-4" />}
              />
            </div>

            <Button
              type="submit"
              variant="primary"
              size="lg"
              className="w-full py-3 text-sm font-semibold shadow-lg shadow-blue-600/25 flex items-center justify-center gap-2"
              isLoading={isLoading}
              disabled={isAnyLoading && !isLoading}
            >
              <span>{isInviteMode ? 'Create Account & Continue' : 'Create Workspace Account'}</span>
              <ArrowRight className="w-4 h-4" />
            </Button>
          </form>

          <div className="pt-3 border-t border-slate-800/80 text-center">
            <p className="text-xs text-slate-400">
              Already have an account?{' '}
              <Link
                href={isInviteMode && tokenParam ? `/login?token=${encodeURIComponent(tokenParam)}` : '/login'}
                className="text-blue-400 hover:underline font-medium"
              >
                Sign in
              </Link>
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
}

export default function SignupPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-slate-950 flex flex-col justify-center items-center p-4">
        <Card className="p-6 text-center text-xs text-slate-400">Loading signup portal...</Card>
      </div>
    }>
      <SignupContent />
    </Suspense>
  );
}
