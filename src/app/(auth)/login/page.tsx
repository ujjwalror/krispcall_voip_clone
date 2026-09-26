'use client';

import React, { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Radio, Lock, Mail, AlertCircle, ShieldCheck, Eye, EyeOff, CheckCircle2 } from 'lucide-react';
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

function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isPasswordLoading, setIsPasswordLoading] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = createClient();

  useEffect(() => {
    const errorType = searchParams.get('error');
    const messageType = searchParams.get('message');

    if (errorType === 'inactive') {
      setErrorMessage('Your account is currently inactive. Please contact your administrator.');
    } else if (errorType === 'unconfigured') {
      setErrorMessage('Your profile has not been configured in the system. Please contact your administrator.');
    } else if (errorType === 'auth_callback_failed') {
      setErrorMessage('Authentication failed or sign-in link expired. Please try again.');
    } else if (errorType === 'session_displaced') {
      setErrorMessage('Your account was signed in on another device. This session has been signed out.');
    }

    if (messageType === 'check-email') {
      setSuccessMessage('Please check your email address for a secure sign-in or confirmation link.');
    }
  }, [searchParams]);

  const handleGoogleLogin = async () => {
    setIsGoogleLoading(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${window.location.origin}/auth/callback`,
        },
      });

      if (error) {
        setErrorMessage(error.message);
        setIsGoogleLoading(false);
      }
    } catch (err: any) {
      setErrorMessage('Failed to initiate Google sign in. Please try again.');
      setIsGoogleLoading(false);
    }
  };

  const handlePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsPasswordLoading(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        if (error.message.includes('Invalid login credentials')) {
          setErrorMessage('Invalid email address or password. Please verify your credentials.');
        } else {
          setErrorMessage(error.message);
        }
        setIsPasswordLoading(false);
        return;
      }

      if (data.user) {
        // Fetch matching profile to verify active status
        const { data: profileData, error: profileError } = await supabase
          .from('profiles')
          .select('active, role')
          .eq('id', data.user.id)
          .maybeSingle();

        const profile = profileData as { active?: boolean; role?: string } | null;

        if (!profile) {
          // Authenticated user has no profile -> redirect to onboarding
          router.push('/onboarding');
          router.refresh();
          return;
        }

        if (!profile.active) {
          setErrorMessage('Your account is currently inactive. Please contact your administrator.');
          await supabase.auth.signOut();
          setIsPasswordLoading(false);
          return;
        }

        // Redirect to dashboard
        router.push('/dashboard');
        router.refresh();
      }
    } catch (err: any) {
      setErrorMessage('An unexpected error occurred during sign in. Please try again.');
    } finally {
      setIsPasswordLoading(false);
    }
  };

  const isAnyLoading = isPasswordLoading || isGoogleLoading;

  return (
    <Card className="p-6 space-y-5 shadow-2xl border-slate-800/80 bg-slate-900/80 backdrop-blur-xl">
      <div className="space-y-1 border-b border-slate-800 pb-3">
        <h2 className="text-base font-semibold text-slate-100">Sign In to Your Workspace</h2>
        <p className="text-xs text-slate-400">Enter your credentials to access your business workspace.</p>
      </div>

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
        onClick={handleGoogleLogin}
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

      <form onSubmit={handlePasswordLogin} className="space-y-4">
        {/* 3. Work Email Address */}
        <div>
          <label className="text-xs font-semibold text-slate-300 block mb-1.5">Work Email Address</label>
          <Input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@company.com"
            icon={<Mail className="w-4 h-4" />}
          />
        </div>

        {/* 4. Password & Forgot Password */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-xs font-semibold text-slate-300">Password</label>
            <Link href="/forgot-password" className="text-[11px] text-blue-400 hover:underline">
              Forgot Password?
            </Link>
          </div>
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
                title={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            }
          />
        </div>

        {/* 5. Sign In to Workspace */}
        <Button
          type="submit"
          variant="primary"
          size="lg"
          className="w-full py-3 text-sm font-semibold shadow-lg shadow-blue-600/25"
          isLoading={isPasswordLoading}
          disabled={isAnyLoading && !isPasswordLoading}
        >
          Sign In to Workspace
        </Button>
      </form>

      {/* Bottom Link */}
      <div className="pt-2 border-t border-slate-800 text-center space-y-2">
        <p className="text-xs text-slate-400">
          Don't have a workspace yet?{' '}
          <Link href="/signup" className="text-blue-400 hover:underline font-medium">
            Create a new workspace
          </Link>
        </p>
        <div className="flex items-center justify-center gap-1.5 text-[11px] text-slate-500">
          <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
          <span>Secure multi-tenant workspace authentication</span>
        </div>
      </div>
    </Card>
  );
}

export default function LoginPage() {
  return (
    <div className="min-h-screen bg-slate-950 flex flex-col justify-center items-center p-4 antialiased selection:bg-blue-500 selection:text-white">
      {/* Background Accent Glows */}
      <div className="fixed top-1/4 left-1/2 -translate-x-1/2 w-96 h-96 bg-blue-600/10 blur-[120px] rounded-full pointer-events-none" />
      <div className="fixed bottom-1/4 left-1/2 -translate-x-1/2 w-96 h-96 bg-indigo-600/10 blur-[120px] rounded-full pointer-events-none" />

      <div className="w-full max-w-md space-y-6 relative z-10">
        {/* Brand Header */}
        <div className="text-center space-y-2">
          <div className="inline-flex p-3 rounded-2xl bg-gradient-to-tr from-blue-600 via-indigo-600 to-cyan-500 text-white shadow-xl shadow-blue-500/20 mb-2">
            <Radio className="w-7 h-7 animate-pulse" />
          </div>
          <h1 className="text-2xl font-bold text-slate-100 tracking-tight flex items-center justify-center gap-2">
            <span>VoIP Hub</span>
            <Badge variant="blue" size="sm">
              COMMERCIAL SAAS
            </Badge>
          </h1>
          <p className="text-xs text-slate-400 font-medium">
            Multi-Tenant Business Telephony & Communications
          </p>
        </div>

        <Suspense fallback={
          <Card className="p-6 text-center text-xs text-slate-400">Loading sign in portal...</Card>
        }>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  );
}

