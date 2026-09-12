'use client';

import React, { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Radio, Lock, Mail, AlertCircle, ShieldCheck, Eye, EyeOff } from 'lucide-react';
import Link from 'next/link';

function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = createClient();

  useEffect(() => {
    const errorType = searchParams.get('error');
    if (errorType === 'inactive') {
      setErrorMessage('Your account is currently inactive. Please contact your administrator.');
    } else if (errorType === 'unconfigured') {
      setErrorMessage('Your profile has not been configured in the system. Please contact your administrator.');
    }
  }, [searchParams]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setErrorMessage(null);

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
        setIsLoading(false);
        return;
      }

      if (data.user) {
        // Fetch matching profile to verify active status
        const { data: profileData, error: profileError } = await supabase
          .from('profiles')
          .select('active, role')
          .eq('id', data.user.id)
          .single();

        const profile = profileData as { active?: boolean; role?: string } | null;

        if (profileError || !profile) {
          setErrorMessage('Your account profile was not found. Please contact your administrator.');
          await supabase.auth.signOut();
          setIsLoading(false);
          return;
        }

        if (!profile.active) {
          setErrorMessage('Your account is currently inactive. Please contact your administrator.');
          await supabase.auth.signOut();
          setIsLoading(false);
          return;
        }

        // Redirect to dashboard
        router.push('/dashboard');
        router.refresh();
      }
    } catch (err: any) {
      setErrorMessage('An unexpected error occurred during sign in. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Card className="p-6 space-y-5 shadow-2xl border-slate-800/80 bg-slate-900/80 backdrop-blur-xl">
      <div className="space-y-1 border-b border-slate-800 pb-3">
        <h2 className="text-base font-semibold text-slate-100">Sign In to Your Workspace</h2>
        <p className="text-xs text-slate-400">Enter your internal team credentials below.</p>
      </div>

      {errorMessage && (
        <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs flex items-start gap-2.5 animate-in fade-in duration-150">
          <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          <div className="leading-relaxed">{errorMessage}</div>
        </div>
      )}

      <form onSubmit={handleLogin} className="space-y-4">
        <div>
          <label className="text-xs font-semibold text-slate-300 block mb-1.5">Work Email Address</label>
          <Input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="agent@legendarycareers.internal"
            icon={<Mail className="w-4 h-4" />}
          />
        </div>

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

        <Button
          type="submit"
          variant="primary"
          size="lg"
          className="w-full py-3 text-sm font-semibold shadow-lg shadow-blue-600/25"
          isLoading={isLoading}
        >
          Sign In to Workspace
        </Button>
      </form>

      <div className="pt-2 border-t border-slate-800 flex items-center justify-center gap-2 text-[11px] text-slate-500">
        <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
        <span>Restricted internal portal. Public registration disabled.</span>
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
              INTERNAL
            </Badge>
          </h1>
          <p className="text-xs text-slate-400 font-medium">
            Legendary Careers Authorized Staff Portal
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
