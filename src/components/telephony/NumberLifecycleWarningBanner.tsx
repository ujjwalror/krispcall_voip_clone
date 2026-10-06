'use client';

import React from 'react';
import { NumberOffboardingState } from '@/lib/telephony/lifecycle/types';
import { AlertTriangle, ShieldAlert, Clock, CreditCard, RefreshCw, ExternalLink } from 'lucide-react';
import Link from 'next/link';

export interface NumberLifecycleWarningBannerProps {
  status: NumberOffboardingState;
  phoneNumberE164: string;
  phoneNumberId?: string;
  paidThroughAt?: string | null;
  effectivePolicyDeadlineAt?: string | null;
  cancellationRequestedAt?: string | null;
  onRestoreClick?: () => void;
  onUpdateBillingClick?: () => void;
  onPortOutClick?: () => void;
  className?: string;
}

export function NumberLifecycleWarningBanner({
  status,
  phoneNumberE164,
  phoneNumberId,
  paidThroughAt,
  effectivePolicyDeadlineAt,
  cancellationRequestedAt,
  onRestoreClick,
  onUpdateBillingClick,
  onPortOutClick,
  className = '',
}: NumberLifecycleWarningBannerProps) {
  // Safe formatting helper for E.164 phone numbers (e.g. +18005550199 -> +1 (800) 555-0199)
  const formatE164 = (e164: string) => {
    if (!e164) return '';
    const cleaned = e164.replace(/[^\d+]/g, '');
    if (cleaned.startsWith('+1') && cleaned.length === 12) {
      return `+1 (${cleaned.slice(2, 5)}) ${cleaned.slice(5, 8)}-${cleaned.slice(8)}`;
    }
    return cleaned;
  };

  const formattedPhone = formatE164(phoneNumberE164);

  // Authoritative deadline check - NO fake dates or countdowns!
  const formattedDeadline = effectivePolicyDeadlineAt
    ? new Date(effectivePolicyDeadlineAt).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : null;

  const formattedPaidThrough = paidThroughAt
    ? new Date(paidThroughAt).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : null;

  // Case 1: Active & Normal -> No warning banner needed
  const isCancelingButPaidThrough =
    status === 'active' &&
    paidThroughAt &&
    new Date(paidThroughAt).getTime() > Date.now();

  if (status === 'active' && !isCancelingButPaidThrough) {
    return null;
  }

  // Case 2: Cancellation requested, paid through future date
  if (isCancelingButPaidThrough) {
    return (
      <div
        role="alert"
        aria-live="polite"
        className={`p-4 rounded-xl border bg-amber-50/80 dark:bg-amber-950/40 border-amber-200 dark:border-amber-800/80 text-amber-900 dark:text-amber-100 ${className}`}
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-lg bg-amber-100 dark:bg-amber-900/60 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5">
              <Clock className="w-5 h-5" />
            </div>
            <div>
              <h4 className="text-sm font-semibold flex items-center gap-2">
                <span>Subscription Cancellation Scheduled</span>
                <span className="font-mono text-xs font-normal text-amber-700 dark:text-amber-300 bg-amber-100 dark:bg-amber-900/80 px-2 py-0.5 rounded">
                  {formattedPhone}
                </span>
              </h4>
              <p className="text-xs text-amber-700 dark:text-amber-300 mt-1 leading-relaxed">
                Service for this number remains active and fully usable through{' '}
                <strong className="font-medium text-amber-900 dark:text-amber-100">
                  {formattedPaidThrough || 'the end of your current billing cycle'}
                </strong>
                . Calling and messaging services will stop after this date.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
            {onRestoreClick ? (
              <button
                onClick={onRestoreClick}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-600 hover:bg-amber-700 text-white shadow-xs transition-colors flex items-center gap-1.5"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Resume Subscription
              </button>
            ) : (
              <Link
                href="/billing"
                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-600 hover:bg-amber-700 text-white shadow-xs transition-colors inline-flex items-center gap-1.5"
              >
                <CreditCard className="w-3.5 h-3.5" />
                Manage Billing
              </Link>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Case 3: PAST_DUE
  if (status === 'past_due') {
    return (
      <div
        role="alert"
        aria-live="assertive"
        className={`p-4 rounded-xl border bg-amber-50/90 dark:bg-amber-950/60 border-amber-300 dark:border-amber-700 text-amber-950 dark:text-amber-50 ${className}`}
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-lg bg-amber-100 dark:bg-amber-900/80 text-amber-700 dark:text-amber-300 shrink-0 mt-0.5">
              <AlertTriangle className="w-5 h-5" />
            </div>
            <div>
              <h4 className="text-sm font-bold flex items-center gap-2 text-amber-900 dark:text-amber-100">
                <span>Payment Required for Phone Number</span>
                <span className="font-mono text-xs font-semibold text-amber-800 dark:text-amber-200 bg-amber-200/80 dark:bg-amber-900/90 px-2 py-0.5 rounded">
                  {formattedPhone}
                </span>
              </h4>
              <p className="text-xs text-amber-800 dark:text-amber-200 mt-1 leading-relaxed">
                {formattedDeadline ? (
                  <>
                    Payment is past due. Action is required before{' '}
                    <strong>{formattedDeadline}</strong> to maintain service and protect your phone number from suspension.
                  </>
                ) : (
                  <>
                    Payment is past due for this number entitlement. Action is required to maintain service and avoid telecom suspension.
                  </>
                )}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
            {onUpdateBillingClick ? (
              <button
                onClick={onUpdateBillingClick}
                className="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-amber-600 hover:bg-amber-700 text-white shadow-xs transition-colors flex items-center gap-1.5"
              >
                <CreditCard className="w-3.5 h-3.5" />
                Update Payment Method
              </button>
            ) : (
              <Link
                href="/billing"
                className="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-amber-600 hover:bg-amber-700 text-white shadow-xs transition-colors inline-flex items-center gap-1.5"
              >
                <CreditCard className="w-3.5 h-3.5" />
                Update Payment Method
              </Link>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Case 4: SUSPENDED
  if (status === 'suspended') {
    return (
      <div
        role="alert"
        aria-live="assertive"
        className={`p-4 rounded-xl border bg-red-50/90 dark:bg-red-950/60 border-red-300 dark:border-red-800 text-red-950 dark:text-red-50 ${className}`}
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-lg bg-red-100 dark:bg-red-900/80 text-red-700 dark:text-red-300 shrink-0 mt-0.5">
              <AlertTriangle className="w-5 h-5" />
            </div>
            <div>
              <h4 className="text-sm font-bold flex items-center gap-2 text-red-900 dark:text-red-100">
                <span>Telecom Service Suspended</span>
                <span className="font-mono text-xs font-semibold text-red-800 dark:text-red-200 bg-red-200/80 dark:bg-red-900/90 px-2 py-0.5 rounded">
                  {formattedPhone}
                </span>
              </h4>
              <p className="text-xs text-red-800 dark:text-red-200 mt-1 leading-relaxed">
                Calling and messaging are currently disabled due to unpaid subscription entitlement.{' '}
                <strong>Your phone number is temporarily retained on your account</strong>, but prompt recovery action is required.
                {formattedDeadline && (
                  <> Policy deadline for restoration: <strong>{formattedDeadline}</strong>.</>
                )}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0 self-end sm:self-center">
            {onRestoreClick ? (
              <button
                onClick={onRestoreClick}
                className="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-red-600 hover:bg-red-700 text-white shadow-xs transition-colors flex items-center gap-1.5"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Restore Service
              </button>
            ) : (
              <Link
                href="/billing"
                className="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-red-600 hover:bg-red-700 text-white shadow-xs transition-colors inline-flex items-center gap-1.5"
              >
                <CreditCard className="w-3.5 h-3.5" />
                Update Payment
              </Link>
            )}
            {onPortOutClick && (
              <button
                onClick={onPortOutClick}
                className="px-3 py-1.5 rounded-lg text-xs font-medium border border-red-300 dark:border-red-700 text-red-700 dark:text-red-300 hover:bg-red-100/50 dark:hover:bg-red-900/40 transition-colors"
              >
                Port Out
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Case 5: RELEASE_PENDING
  if (status === 'release_pending') {
    return (
      <div
        role="alert"
        aria-live="assertive"
        className={`p-4 rounded-xl border bg-rose-100 dark:bg-rose-950/80 border-rose-400 dark:border-rose-700 text-rose-950 dark:text-rose-50 shadow-md ${className}`}
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-lg bg-rose-200 dark:bg-rose-900 text-rose-800 dark:text-rose-200 shrink-0 mt-0.5 animate-pulse">
              <ShieldAlert className="w-5 h-5 text-rose-600 dark:text-rose-400" />
            </div>
            <div>
              <h4 className="text-sm font-extrabold flex items-center gap-2 text-rose-950 dark:text-rose-100 tracking-tight">
                <span>URGENT: Number at Risk of Permanent Release</span>
                <span className="font-mono text-xs font-bold text-rose-900 dark:text-rose-100 bg-rose-200/90 dark:bg-rose-900/90 px-2 py-0.5 rounded border border-rose-300 dark:border-rose-700">
                  {formattedPhone}
                </span>
              </h4>
              <p className="text-xs text-rose-900 dark:text-rose-200 mt-1 leading-relaxed font-medium">
                Service is suspended and this number is now entering final release eligibility.{' '}
                {formattedDeadline ? (
                  <>
                    Authoritative carrier release deadline: <strong className="underline">{formattedDeadline}</strong>. If unaddressed, the number will be surrendered back to global carrier inventory.
                  </>
                ) : (
                  <>
                    Immediate payment or port-out action is required to maintain ownership and prevent permanent surrender to carrier inventory.
                  </>
                )}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0 self-end sm:self-center">
            {onRestoreClick ? (
              <button
                onClick={onRestoreClick}
                className="px-4 py-2 rounded-lg text-xs font-bold bg-rose-700 hover:bg-rose-800 text-white shadow-md transition-colors flex items-center gap-1.5"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Restore Service Now
              </button>
            ) : (
              <Link
                href="/billing"
                className="px-4 py-2 rounded-lg text-xs font-bold bg-rose-700 hover:bg-rose-800 text-white shadow-md transition-colors inline-flex items-center gap-1.5"
              >
                <CreditCard className="w-3.5 h-3.5" />
                Pay & Retain Number
              </Link>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Case 6: RELEASED
  if (status === 'released') {
    return (
      <div
        role="alert"
        aria-live="polite"
        className={`p-4 rounded-xl border bg-slate-100 dark:bg-slate-900 border-slate-300 dark:border-slate-800 text-slate-700 dark:text-slate-300 ${className}`}
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-lg bg-slate-200 dark:bg-slate-800 text-slate-500 shrink-0 mt-0.5">
              <Clock className="w-5 h-5" />
            </div>
            <div>
              <h4 className="text-sm font-semibold flex items-center gap-2 text-slate-900 dark:text-slate-100">
                <span>Number Surrendered & Released</span>
                <span className="font-mono text-xs font-normal text-slate-600 dark:text-slate-400 bg-slate-200 dark:bg-slate-800 px-2 py-0.5 rounded">
                  {formattedPhone}
                </span>
              </h4>
              <p className="text-xs text-slate-600 dark:text-slate-400 mt-1 leading-relaxed">
                This phone number is no longer active on your account. Historical call logs, recordings, and message records remain safely accessible in accordance with data retention rules. Re-activation of the same number cannot be guaranteed.
              </p>
            </div>
          </div>
          {phoneNumberId && (
            <Link
              href={`/numbers/${phoneNumberId}`}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 transition-colors inline-flex items-center gap-1.5 shrink-0 self-end sm:self-center"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              View Historical Records
            </Link>
          )}
        </div>
      </div>
    );
  }

  return null;
}
