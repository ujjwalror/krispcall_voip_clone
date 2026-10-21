'use client';

import React, { useState, useEffect, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Radio, Mail, ArrowLeft, CheckCircle2, AlertCircle, RefreshCw, HelpCircle, Clock, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import {
  AuthChallengeWidget,
  AuthChallengeWidgetRef,
  isTurnstileConfigured,
  DEFAULT_PROVIDER_RECOVERY_COOLDOWN_SECONDS,
  canProceedWithPasswordAuth,
  SAFE_CAPTCHA_UNAVAILABLE_MESSAGE,
} from '@/lib/auth/captcha';
import { normalizeAuthError } from '@/lib/auth/errors';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [resendNotice, setResendNotice] = useState<string | null>(null);

  // Invariant SEC6-014: Cooldown timer for UX suppression (Default 60 seconds provider window)
  const [cooldownSeconds, setCooldownSeconds] = useState(0);

  // Invariant SEC6-003 / SEC6-004: Ephemeral challenge token in browser memory only
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const challengeRef = useRef<AuthChallengeWidgetRef | null>(null);

  const supabase = createClient();

  // Cooldown countdown timer
  useEffect(() => {
    if (cooldownSeconds <= 0) return;
    const interval = setInterval(() => {
      setCooldownSeconds((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(interval);
  }, [cooldownSeconds]);

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setErrorMessage(null);
    setResendNotice(null);

    // Invariant SEC6-001 / SEC6-011 / AUTH-CAPTCHA-FAILURE-001: Enforce fail-closed CAPTCHA check
    if (!canProceedWithPasswordAuth(captchaToken)) {
      setErrorMessage(SAFE_CAPTCHA_UNAVAILABLE_MESSAGE);
      setIsLoading(false);
      return;
    }

    try {
      const redirectUrl = `${window.location.origin}/auth/callback?next=/reset-password`;

      // Invariant SEC6-011: Propagate captchaToken into resetPasswordForEmail
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: redirectUrl,
        captchaToken: captchaToken || undefined,
      });

      // Invariant SEC6-005 / SEC6-017: Immediately invalidate/reset challenge token
      setCaptchaToken(null);
      challengeRef.current?.reset();

      if (error) {
        const normalized = normalizeAuthError(error, 'recovery');
        setErrorMessage(normalized.safeUserMessage);
      } else {
        // Invariant SEC6-012 / SEC6-016: State is REQUEST_ACCEPTED, never reveal account existence
        setIsSubmitted(true);
        setCooldownSeconds(DEFAULT_PROVIDER_RECOVERY_COOLDOWN_SECONDS);
      }
    } catch (err: any) {
      setCaptchaToken(null);
      challengeRef.current?.reset();
      const normalized = normalizeAuthError(err, 'recovery');
      setErrorMessage(normalized.safeUserMessage);
    } finally {
      setIsLoading(false);
    }
  };

  // Invariant SEC6-013: Recovery resend calls resetPasswordForEmail(), NOT auth.resend()
  const handleResend = async () => {
    if (cooldownSeconds > 0) return;

    // Invariant SEC6-014 / AUTH-CAPTCHA-FAILURE-001: Enforce fail-closed CAPTCHA check
    if (!canProceedWithPasswordAuth(captchaToken)) {
      setErrorMessage(SAFE_CAPTCHA_UNAVAILABLE_MESSAGE);
      return;
    }

    setIsResending(true);
    setErrorMessage(null);
    setResendNotice(null);

    try {
      const redirectUrl = `${window.location.origin}/auth/callback?next=/reset-password`;

      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: redirectUrl,
        captchaToken: captchaToken || undefined,
      });

      // Invalidate challenge token after resend attempt
      setCaptchaToken(null);
      challengeRef.current?.reset();

      if (error) {
        const normalized = normalizeAuthError(error, 'recovery');
        setErrorMessage(normalized.safeUserMessage);
      } else {
        // Invariant SEC6-032: Neutral confirmation; restart cooldown
        setResendNotice('If an account exists, a new recovery email has been dispatched.');
        setCooldownSeconds(DEFAULT_PROVIDER_RECOVERY_COOLDOWN_SECONDS);
      }
    } catch (err: any) {
      setCaptchaToken(null);
      challengeRef.current?.reset();
      const normalized = normalizeAuthError(err, 'recovery');
      setErrorMessage(normalized.safeUserMessage);
    } finally {
      setIsResending(false);
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
              PASSWORD RECOVERY
            </Badge>
          </h1>
        </div>

        <Card className="p-6 space-y-5 shadow-2xl border-slate-800/80 bg-slate-900/80 backdrop-blur-xl">
          {!isSubmitted ? (
            <>
              <div className="space-y-1 border-b border-slate-800 pb-3">
                <h2 className="text-base font-semibold text-slate-100">Reset Your Password</h2>
                <p className="text-xs text-slate-400">
                  Enter your work email address to receive password recovery instructions.
                </p>
              </div>

              {errorMessage && (
                <div
                  data-testid="recovery-error-banner"
                  className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs flex items-start gap-2.5"
                >
                  <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                  <div>{errorMessage}</div>
                </div>
              )}

              <form onSubmit={handleReset} className="space-y-4">
                <div>
                  <label className="text-xs font-semibold text-slate-300 block mb-1.5">Work Email Address</label>
                  <Input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="name@company.com"
                    icon={<Mail className="w-4 h-4" />}
                    disabled={isLoading}
                  />
                </div>

                {/* Security Challenge (Turnstile) */}
                <AuthChallengeWidget
                  ref={challengeRef}
                  onVerify={(tok) => setCaptchaToken(tok)}
                  onExpire={() => setCaptchaToken(null)}
                  onError={() => setCaptchaToken(null)}
                  action="recovery"
                  disabled={isLoading}
                />

                <Button
                  type="submit"
                  variant="primary"
                  size="lg"
                  className="w-full py-3 font-semibold shadow-lg shadow-blue-600/25"
                  isLoading={isLoading}
                >
                  Send Recovery Link
                </Button>
              </form>
            </>
          ) : (
            <div className="space-y-4">
              {/* Neutral Acknowledgement (Invariant SEC6-012 / SEC6-016) */}
              <div className="text-center py-2 space-y-2">
                <div className="inline-flex p-3 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 mb-1">
                  <CheckCircle2 className="w-8 h-8" />
                </div>
                <h2 className="text-base font-bold text-slate-100">Recovery Request Accepted</h2>
                <p className="text-xs text-slate-300 max-w-sm mx-auto leading-relaxed">
                  If an account exists with this email address, password recovery instructions have been sent.
                </p>
              </div>

              {resendNotice && (
                <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-xs flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>{resendNotice}</span>
                </div>
              )}

              {errorMessage && (
                <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                  <span>{errorMessage}</span>
                </div>
              )}

              {/* Email Did Not Arrive Guidance Panel (Section 9) */}
              <div className="p-3.5 rounded-xl bg-slate-800/60 border border-slate-700/60 space-y-2.5 text-xs text-slate-300">
                <div className="flex items-center gap-2 text-slate-200 font-semibold text-xs border-b border-slate-700/60 pb-1.5">
                  <HelpCircle className="w-3.5 h-3.5 text-blue-400" />
                  <span>Didn't receive an email?</span>
                </div>
                <ul className="space-y-1.5 text-slate-400 text-[11px] list-disc list-inside">
                  <li>Check your spam or junk folder for automated delivery.</li>
                  <li>Delivery can take 1–2 minutes depending on your email provider.</li>
                  <li>Ensure your email address was typed correctly.</li>
                  <li>If your account is inactive or unconfigured, contact your administrator.</li>
                </ul>
              </div>

              {/* Resend Action with Turnstile Challenge & Cooldown (Section 8) */}
              <div className="space-y-2 pt-1 border-t border-slate-800">
                <AuthChallengeWidget
                  ref={challengeRef}
                  onVerify={(tok) => setCaptchaToken(tok)}
                  onExpire={() => setCaptchaToken(null)}
                  onError={() => setCaptchaToken(null)}
                  action="recovery_resend"
                  disabled={cooldownSeconds > 0 || isResending}
                />

                <Button
                  type="button"
                  variant="outline"
                  size="md"
                  className="w-full text-xs font-medium flex items-center justify-center gap-2"
                  onClick={handleResend}
                  disabled={cooldownSeconds > 0 || isResending}
                  isLoading={isResending}
                >
                  {cooldownSeconds > 0 ? (
                    <>
                      <Clock className="w-3.5 h-3.5 text-slate-400" />
                      <span>Resend available in {cooldownSeconds}s</span>
                    </>
                  ) : (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 text-blue-400" />
                      <span>Resend Recovery Email</span>
                    </>
                  )}
                </Button>
              </div>
            </div>
          )}

          <div className="pt-3 border-t border-slate-800 text-center">
            <Link
              href="/login"
              className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors font-medium"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Return to Sign In</span>
            </Link>
          </div>
        </Card>
      </div>
    </div>
  );
}
