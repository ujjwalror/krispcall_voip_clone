'use client';

import React, { useEffect, useState, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useAuth } from '@/components/providers/AuthProvider';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Radio, Users, CheckCircle2, AlertTriangle, Loader2, ArrowRight, LogOut, ShieldCheck } from 'lucide-react';
import Link from 'next/link';

interface InviteDetails {
  id: string;
  email: string;
  role: string;
  organizationName: string;
  organizationSlug: string;
}

function InvitationAcceptanceContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get('token');

  const { user, profile, signOut, refreshProfile } = useAuth();
  const [invite, setInvite] = useState<InviteDetails | null>(null);
  const [isLoadingVerify, setIsLoadingVerify] = useState(true);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [isAccepting, setIsAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [fullNameInput, setFullNameInput] = useState('');

  useEffect(() => {
    if (!token) {
      setVerifyError('No invitation token specified. Please check your invitation link.');
      setIsLoadingVerify(false);
      return;
    }

    async function verifyToken() {
      try {
        const res = await fetch(`/api/invitations/verify?token=${encodeURIComponent(token!)}`);
        const data = await res.json();
        if (res.ok && data.invitation) {
          setInvite(data.invitation);
        } else {
          setVerifyError(data.error || 'Invalid or expired invitation token.');
        }
      } catch (err: any) {
        console.error('[InviteAcceptPage] Verification error:', err);
        setVerifyError('Unable to connect to server to verify invitation link.');
      } finally {
        setIsLoadingVerify(false);
      }
    }

    verifyToken();
  }, [token]);

  const handleAccept = async () => {
    if (!token) return;
    setIsAccepting(true);
    setAcceptError(null);

    try {
      const res = await fetch('/api/invitations/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          fullName: fullNameInput || user?.user_metadata?.full_name || undefined,
        }),
      });

      const data = await res.json();
      if (res.ok && data.success) {
        await refreshProfile();
        router.push('/dashboard');
        router.refresh();
      } else {
        setAcceptError(data.error || 'Failed to accept invitation.');
      }
    } catch (err: any) {
      setAcceptError(err.message || 'System error accepting invitation.');
    } finally {
      setIsAccepting(false);
    }
  };

  if (isLoadingVerify) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100 p-4">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
          <p className="text-xs text-slate-400">Verifying workspace invitation...</p>
        </div>
      </div>
    );
  }

  if (verifyError || !invite) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100 p-4">
        <Card className="w-full max-w-md p-6 bg-slate-900 border-slate-800 text-center space-y-4">
          <div className="w-12 h-12 rounded-2xl bg-rose-500/10 text-rose-400 border border-rose-500/20 flex items-center justify-center mx-auto">
            <AlertTriangle className="w-6 h-6" />
          </div>
          <h2 className="text-lg font-bold text-slate-100">Invalid Invitation</h2>
          <p className="text-xs text-slate-400 leading-relaxed">{verifyError || 'This invitation is invalid or expired.'}</p>
          <div className="pt-2">
            <Link
              href="/login"
              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-lg shadow-blue-600/20 transition-all"
            >
              Go to Sign In
            </Link>
          </div>
        </Card>
      </div>
    );
  }

  const userEmail = user?.email?.toLowerCase().trim();
  const invitedEmail = invite.email.toLowerCase().trim();
  const isEmailMatch = userEmail === invitedEmail;

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-slate-950 text-slate-100 p-4">
      {/* Brand Header */}
      <div className="flex items-center gap-2 mb-6">
        <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-blue-600 via-indigo-600 to-cyan-500 flex items-center justify-center text-white shadow-lg shadow-blue-500/20">
          <Radio className="w-5 h-5 animate-pulse" />
        </div>
        <span className="font-bold text-lg text-slate-100 tracking-tight">VoIP Hub</span>
      </div>

      <Card className="w-full max-w-md p-6 bg-slate-900/90 border-slate-800 shadow-2xl backdrop-blur-xl space-y-6">
        {/* Invitation Banner */}
        <div className="text-center space-y-2">
          <div className="w-12 h-12 rounded-2xl bg-blue-500/10 border border-blue-500/20 text-blue-400 flex items-center justify-center mx-auto">
            <Users className="w-6 h-6" />
          </div>
          <h1 className="text-xl font-bold tracking-tight text-white">Workspace Invitation</h1>
          <p className="text-xs text-slate-400 leading-relaxed">
            You've been invited to join <strong className="text-slate-200">{invite.organizationName}</strong>.
          </p>
          <div className="pt-1 flex items-center justify-center gap-2">
            <span className="text-[11px] text-slate-400">Assigned Role:</span>
            <Badge variant={invite.role === 'admin' ? 'purple' : invite.role === 'manager' ? 'blue' : 'emerald'} size="sm">
              {invite.role.toUpperCase()}
            </Badge>
          </div>
        </div>

        {/* Authenticated Flow */}
        {user ? (
          <div className="space-y-4">
            <div className="p-3 rounded-xl bg-slate-950/80 border border-slate-800 text-xs space-y-1">
              <span className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">Signed In As</span>
              <p className="font-mono font-medium text-slate-200">{user.email}</p>
            </div>

            {profile ? (
              <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs leading-relaxed flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>You already belong to a workspace organization. Switch accounts to accept this invitation.</span>
              </div>
            ) : !isEmailMatch ? (
              <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs leading-relaxed flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>
                  Your signed-in email (<strong className="font-mono">{user.email}</strong>) does not match the invited email address (<strong className="font-mono">{invite.email}</strong>). Please log out and sign in with <strong className="font-mono">{invite.email}</strong>.
                </span>
              </div>
            ) : (
              <div className="space-y-3">
                {!user.user_metadata?.full_name && (
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">Your Full Name</label>
                    <input
                      type="text"
                      placeholder="e.g. Jane Doe"
                      value={fullNameInput}
                      onChange={(e) => setFullNameInput(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500"
                    />
                  </div>
                )}

                {acceptError && (
                  <div className="p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/20 text-xs text-rose-300">
                    {acceptError}
                  </div>
                )}

                <Button
                  variant="primary"
                  size="lg"
                  className="w-full font-semibold py-3 flex items-center justify-center gap-2"
                  onClick={handleAccept}
                  disabled={isAccepting}
                >
                  {isAccepting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Joining Workspace...</span>
                    </>
                  ) : (
                    <>
                      <span>Accept Invitation & Join</span>
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </Button>
              </div>
            )}

            <button
              onClick={() => signOut()}
              className="w-full flex items-center justify-center gap-1.5 py-2 text-xs text-slate-400 hover:text-rose-400 transition-colors"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Log out or switch account</span>
            </button>
          </div>
        ) : (
          /* Unauthenticated Flow */
          <div className="space-y-4">
            <div className="p-3 rounded-xl bg-blue-500/10 border border-blue-500/20 text-xs text-blue-300 leading-relaxed text-center">
              Please sign in or create an account with <strong className="font-mono text-white">{invite.email}</strong> to join <strong className="text-white">{invite.organizationName}</strong>.
            </div>

            <div className="space-y-2 pt-2">
              <Link
                href={`/signup?email=${encodeURIComponent(invite.email)}&token=${encodeURIComponent(token!)}`}
                className="w-full flex items-center justify-center gap-2 py-3 px-4 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-lg shadow-blue-600/20 transition-all"
              >
                <span>Create Account to Join</span>
                <ArrowRight className="w-4 h-4" />
              </Link>
              <Link
                href={`/login?email=${encodeURIComponent(invite.email)}&token=${encodeURIComponent(token!)}`}
                className="w-full flex items-center justify-center gap-2 py-3 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700 transition-all"
              >
                <span>Sign In to Existing Account</span>
              </Link>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

export default function InvitationAcceptancePage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100">
          <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
        </div>
      }
    >
      <InvitationAcceptanceContent />
    </Suspense>
  );
}
