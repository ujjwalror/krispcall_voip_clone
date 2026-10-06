'use client';

import React from 'react';
import { NumberOffboardingState } from '@/lib/telephony/lifecycle/types';
import { AlertTriangle, CheckCircle2, XCircle, Clock, ShieldAlert } from 'lucide-react';

interface NumberLifecycleBadgeProps {
  status: NumberOffboardingState;
  paidThroughAt?: string | null;
  serviceEndedAt?: string | null;
  showDetails?: boolean;
}

export function NumberLifecycleBadge({
  status,
  paidThroughAt,
  serviceEndedAt,
  showDetails = false,
}: NumberLifecycleBadgeProps) {
  const isCancelingButPaidThrough =
    status === 'active' &&
    paidThroughAt &&
    new Date(paidThroughAt).getTime() > Date.now();

  const formattedPaidThrough = paidThroughAt
    ? new Date(paidThroughAt).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : null;

  if (isCancelingButPaidThrough) {
    return (
      <div className="inline-flex flex-col gap-1">
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border border-amber-200/80 dark:border-amber-800/60">
          <Clock className="w-3.5 h-3.5 text-amber-500" />
          Cancellation Scheduled
        </span>
        {showDetails && formattedPaidThrough && (
          <span className="text-[11px] text-slate-500 dark:text-slate-400">
            Active through {formattedPaidThrough}
          </span>
        )}
      </div>
    );
  }

  switch (status) {
    case 'active':
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200/80 dark:border-emerald-800/60">
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
          Active
        </span>
      );

    case 'past_due':
      return (
        <div className="inline-flex flex-col gap-1">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border border-amber-200/80 dark:border-amber-800/60">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
            Payment Required
          </span>
          {showDetails && (
            <span className="text-[11px] text-amber-600 dark:text-amber-400 font-medium">
              Action is required to maintain this number.
            </span>
          )}
        </div>
      );

    case 'suspended':
      return (
        <div className="inline-flex flex-col gap-1">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 border border-red-200/80 dark:border-red-800/60">
            <XCircle className="w-3.5 h-3.5 text-red-500" />
            Service Suspended
          </span>
          {showDetails && (
            <span className="text-[11px] text-red-600 dark:text-red-400 font-medium">
              Calling & messaging suspended due to unpaid entitlement.
            </span>
          )}
        </div>
      );

    case 'release_pending':
      return (
        <div className="inline-flex flex-col gap-1">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-rose-100 dark:bg-rose-950/80 text-rose-800 dark:text-rose-200 border border-rose-300 dark:border-rose-700 animate-pulse">
            <ShieldAlert className="w-3.5 h-3.5 text-rose-600 dark:text-rose-400" />
            Number at Risk
          </span>
          {showDetails && (
            <span className="text-[11px] text-rose-700 dark:text-rose-300 font-semibold">
              Immediate payment required to prevent carrier release.
            </span>
          )}
        </div>
      );

    case 'released':
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700">
          <XCircle className="w-3.5 h-3.5 text-slate-400" />
          Released
        </span>
      );

    default:
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
          Active
        </span>
      );
  }
}
