'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Card } from '@/components/ui/Card';
import { Building2, Globe, User, AlertCircle, ArrowRight, ShieldCheck, Sparkles } from 'lucide-react';

export default function OnboardingPage() {
  const [fullName, setFullName] = useState('');
  const [orgName, setOrgName] = useState('');
  const [slug, setSlug] = useState('');
  const [isSlugManuallyEdited, setIsSlugManuallyEdited] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    // Verify user is authenticated
    async function checkAuth() {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        router.push('/login');
        return;
      }

      // Pre-fill full name from Google metadata or signup user metadata if available
      const metaName =
        user.user_metadata?.full_name ||
        user.user_metadata?.name ||
        user.user_metadata?.custom_claims?.full_name ||
        '';
      if (metaName && !fullName) {
        setFullName(metaName);
      }

      // If user already has a profile, redirect to dashboard immediately
      const { data: profile } = await supabase
        .from('profiles')
        .select('id')
        .eq('id', user.id)
        .maybeSingle();

      if (profile) {
        router.push('/dashboard');
      }
    }

    checkAuth();
  }, [router, supabase]);

  // Handle auto slug generation from org name
  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setOrgName(val);
    if (!isSlugManuallyEdited) {
      const autoSlug = val
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      setSlug(autoSlug);
    }
  };

  const handleSlugChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setIsSlugManuallyEdited(true);
    const val = e.target.value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    setSlug(val);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setErrorMessage(null);

    try {
      const res = await fetch('/api/onboarding/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName,
          orgName,
          slug,
        }),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        setErrorMessage(data.error || 'Failed to complete workspace onboarding. Please try again.');
        setIsLoading(false);
        return;
      }

      router.push('/dashboard');
      router.refresh();
    } catch (err: any) {
      setErrorMessage('An unexpected error occurred during onboarding. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col justify-center py-12 sm:px-6 lg:px-8 text-slate-100 relative overflow-hidden">
      {/* Background glow accents */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-blue-600/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-1/4 right-1/4 w-80 h-80 bg-indigo-600/10 rounded-full blur-3xl pointer-events-none" />

      <div className="sm:mx-auto sm:w-full sm:max-w-md text-center space-y-3 z-10">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs font-medium">
          <Sparkles className="w-3.5 h-3.5" />
          <span>Set Up Your Business Workspace</span>
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-white">Welcome to VoIP Hub</h1>
        <p className="text-xs text-slate-400 max-w-sm mx-auto">
          Create your organization workspace to start making calls, managing team members, and unifying communications.
        </p>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md z-10">
        <Card className="p-6 space-y-5 shadow-2xl border-slate-800/80 bg-slate-900/80 backdrop-blur-xl">
          <div className="space-y-1 border-b border-slate-800 pb-3">
            <h2 className="text-base font-semibold text-slate-100">Workspace Details</h2>
            <p className="text-xs text-slate-400">Enter your business information below.</p>
          </div>

          {errorMessage && (
            <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs flex items-start gap-2.5 animate-in fade-in duration-150">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <div className="leading-relaxed">{errorMessage}</div>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="text-xs font-semibold text-slate-300 block mb-1.5">
                Your Full Name
              </label>
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
              <label className="text-xs font-semibold text-slate-300 block mb-1.5">
                Organization / Company Name
              </label>
              <Input
                type="text"
                required
                value={orgName}
                onChange={handleNameChange}
                placeholder="Acme Telecom Solutions"
                icon={<Building2 className="w-4 h-4" />}
              />
            </div>

            <div>
              <label className="text-xs font-semibold text-slate-300 block mb-1.5">
                Workspace URL Slug
              </label>
              <Input
                type="text"
                required
                value={slug}
                onChange={handleSlugChange}
                placeholder="acme-telecom"
                icon={<Globe className="w-4 h-4" />}
              />
              <p className="text-[11px] text-slate-500 mt-1">
                Your workspace identifier: <span className="text-slate-400 font-mono">voiphub.app/{slug || 'your-company'}</span>
              </p>
            </div>

            <div className="pt-2">
              <Button
                type="submit"
                variant="primary"
                size="lg"
                className="w-full py-3 text-sm font-semibold shadow-lg shadow-blue-600/25 flex items-center justify-center gap-2"
                isLoading={isLoading}
              >
                <span>Complete Onboarding</span>
                <ArrowRight className="w-4 h-4" />
              </Button>
            </div>
          </form>

          <div className="pt-3 border-t border-slate-800/80 text-center">
            <div className="flex items-center justify-center gap-1.5 text-[11px] text-slate-500">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
              <span>You will become the Organization Owner with full administrative controls</span>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

