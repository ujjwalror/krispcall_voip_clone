'use client';

import React, { useState } from 'react';
import { formatRenewalDeadline } from '@/lib/telephony/renewal/deadlineFormatter';

export type StageUxType =
  | 'FUNDED_ACTIVE'
  | 'T_MINUS_7_NOTICE'
  | 'T_MINUS_5_AUTOPAY_SCHEDULED'
  | 'T_MINUS_5_PAYMENT_REQUIRED'
  | 'FAILED_PAYMENT_ALERT'
  | 'T_MINUS_2_STRONG_WARNING'
  | 'T_MINUS_1_FINAL_WARNING'
  | 'T0_PENDING_PAYMENT'
  | 'T0_PORT_OUT_ACTIVE'
  | 'T0_RECONCILIATION_REQUIRED'
  | 'T0_RELEASE_ELIGIBLE'
  | 'RELEASED';

export interface CustomerRenewalCardProps {
  phoneNumberE164: string;
  phoneNumberId: string;
  stageType: StageUxType;
  providerNextExposureAt: string;
  customerFundedThroughAt: string;
  amountMinor?: number;
  currency?: string;
  autopayAuthorized?: boolean; // Autopay preference source of truth (false if unauthorized)
  failureReason?: string;
  userTimeZone?: string | null;
  onPayRenewClick?: () => void;
  onPortOutClick?: () => void;
  onVoluntaryReleaseClick?: () => void;
}

export function CustomerRenewalCard({
  phoneNumberE164,
  phoneNumberId,
  stageType,
  providerNextExposureAt,
  customerFundedThroughAt,
  amountMinor = 1500,
  currency = 'USD',
  autopayAuthorized = false,
  failureReason,
  userTimeZone,
  onPayRenewClick,
  onPortOutClick,
  onVoluntaryReleaseClick,
}: CustomerRenewalCardProps) {
  const [showPortOutNotice, setShowPortOutNotice] = useState(false);
  const [showReleaseModal, setShowReleaseModal] = useState(false);
  const [paymentProcessing, setPaymentProcessing] = useState(false);

  const localizedDeadline = formatRenewalDeadline(providerNextExposureAt, userTimeZone);
  const formattedAmount = `$${(amountMinor / 100).toFixed(2)} ${currency}`;

  const handlePayClick = () => {
    setPaymentProcessing(true);
    // Safe gated billing foundation hook — Stripe capture remains gated OFF
    if (onPayRenewClick) {
      onPayRenewClick();
    }
    setTimeout(() => setPaymentProcessing(false), 1000);
  };

  const handlePortOutAction = () => {
    setShowPortOutNotice(true);
    if (onPortOutClick) {
      onPortOutClick();
    }
  };

  const handleReleaseAction = () => {
    setShowReleaseModal(true);
    if (onVoluntaryReleaseClick) {
      onVoluntaryReleaseClick();
    }
  };

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-6 text-slate-100 shadow-lg transition-all">
      {/* Header & Status Pill */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <h3 className="font-mono text-lg font-bold text-slate-100">{phoneNumberE164}</h3>
          <p className="text-xs text-slate-400">Phone Number Entitlement</p>
        </div>

        {/* State Badges */}
        {stageType === 'FUNDED_ACTIVE' && (
          <span className="rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-400 border border-emerald-500/20">
            Active / Funded
          </span>
        )}

        {stageType === 'T_MINUS_7_NOTICE' && (
          <span className="rounded-full bg-blue-500/10 px-3 py-1 text-xs font-semibold text-blue-400 border border-blue-500/20">
            Upcoming Renewal
          </span>
        )}

        {(stageType === 'T_MINUS_5_PAYMENT_REQUIRED' || stageType === 'T_MINUS_5_AUTOPAY_SCHEDULED') && (
          <span className="rounded-full bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-400 border border-amber-500/20">
            {autopayAuthorized ? 'Autopay Scheduled' : 'Payment Required'}
          </span>
        )}

        {stageType === 'FAILED_PAYMENT_ALERT' && (
          <span className="rounded-full bg-rose-500/10 px-3 py-1 text-xs font-semibold text-rose-400 border border-rose-500/20">
            Payment Failure
          </span>
        )}

        {stageType === 'T_MINUS_2_STRONG_WARNING' && (
          <span className="rounded-full bg-orange-500/10 px-3 py-1 text-xs font-semibold text-orange-400 border border-orange-500/20">
            Action Required
          </span>
        )}

        {stageType === 'T_MINUS_1_FINAL_WARNING' && (
          <span className="rounded-full bg-rose-500/20 px-3 py-1 text-xs font-bold text-rose-400 border border-rose-500/30 animate-pulse">
            Final Notice
          </span>
        )}

        {stageType === 'T0_PENDING_PAYMENT' && (
          <span className="rounded-full bg-purple-500/10 px-3 py-1 text-xs font-semibold text-purple-400 border border-purple-500/20">
            Payment Pending — Release Blocked
          </span>
        )}

        {stageType === 'T0_PORT_OUT_ACTIVE' && (
          <span className="rounded-full bg-indigo-500/10 px-3 py-1 text-xs font-semibold text-indigo-400 border border-indigo-500/20">
            Port Out In Progress — Release Blocked
          </span>
        )}

        {stageType === 'T0_RECONCILIATION_REQUIRED' && (
          <span className="rounded-full bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-400 border border-amber-500/20">
            Review Required — Release Blocked
          </span>
        )}

        {stageType === 'T0_RELEASE_ELIGIBLE' && (
          <span className="rounded-full bg-red-500/20 px-3 py-1 text-xs font-bold text-red-400 border border-red-500/30">
            Release Eligible (Pre-Release Check Active)
          </span>
        )}

        {stageType === 'RELEASED' && (
          <span className="rounded-full bg-slate-800 px-3 py-1 text-xs font-semibold text-slate-500">
            Released
          </span>
        )}
      </div>

      {/* Main Details Body */}
      <div className="mt-4 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          <div>
            <span className="text-slate-400">Renewal Amount:</span>{' '}
            <span className="font-semibold text-slate-200">{formattedAmount} / month</span>
          </div>
          <div>
            <span className="text-slate-400">Payment Deadline:</span>{' '}
            <span className="font-mono font-semibold text-amber-300">{localizedDeadline}</span>
          </div>
          <div>
            <span className="text-slate-400">Autopay Status:</span>{' '}
            <span className="font-semibold text-slate-200">
              {autopayAuthorized ? 'Enabled (Authorized Payment Method)' : 'Disabled / Not Configured'}
            </span>
          </div>
        </div>

        {/* Message Banner based on Stage */}
        {stageType === 'T_MINUS_5_PAYMENT_REQUIRED' && !autopayAuthorized && (
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-4 text-xs text-amber-200">
            <p className="font-semibold text-amber-300">Payment Required</p>
            <p className="mt-1">
              Your phone number <span className="font-mono">{phoneNumberE164}</span> requires renewal.
              Payment of {formattedAmount} is required by{' '}
              <span className="font-semibold text-slate-100">{localizedDeadline}</span> to continue maintaining this number.
              If payment is not received by the applicable deadline and you have not started an eligible port-out,
              your number may become eligible for automatic release after the required safety checks.
            </p>
          </div>
        )}

        {stageType === 'FAILED_PAYMENT_ALERT' && (
          <div className="rounded-lg border border-rose-500/20 bg-rose-500/5 p-4 text-xs text-rose-200">
            <p className="font-semibold text-rose-300">Payment Attempt Failed</p>
            <p className="mt-1">
              The automated payment attempt for <span className="font-mono">{phoneNumberE164}</span> failed
              {failureReason ? ` (${failureReason})` : ''}. Please update your payment method or complete payment manually by{' '}
              <span className="font-semibold text-slate-100">{localizedDeadline}</span>.
            </p>
          </div>
        )}

        {stageType === 'T_MINUS_2_STRONG_WARNING' && (
          <div className="rounded-lg border border-orange-500/30 bg-orange-500/10 p-4 text-xs text-orange-200">
            <p className="font-semibold text-orange-300">Action Required — Renewal Warning</p>
            <p className="mt-1">
              Payment is still required to maintain this phone number.
              If payment is not completed by <span className="font-semibold text-slate-100">{localizedDeadline}</span>, your number
              may become eligible for release after safety verification.
            </p>
          </div>
        )}

        {stageType === 'T_MINUS_1_FINAL_WARNING' && (
          <div className="rounded-lg border border-rose-500/40 bg-rose-500/15 p-4 text-xs text-rose-200">
            <p className="font-bold text-rose-300">FINAL NOTICE: Number Loss Risk</p>
            <p className="mt-1">
              Final notice: your phone number is not funded for its next rental period.
              Complete payment by <span className="font-semibold text-slate-100">{localizedDeadline}</span>.
              If payment is not completed by this deadline and no eligible port-out or other protection is in progress,
              your number may become eligible for automatic release. Once a number is released, recovery cannot be guaranteed.
            </p>
          </div>
        )}

        {stageType === 'T0_PORT_OUT_ACTIVE' && (
          <div className="rounded-lg border border-indigo-500/20 bg-indigo-500/5 p-4 text-xs text-indigo-200">
            <p className="font-semibold text-indigo-300">Port-Out In Progress</p>
            <p className="mt-1">
              Your port-out for <span className="font-mono">{phoneNumberE164}</span> is active. Automatic release is strictly BLOCKED.
              Please note that rental funding remains required until porting completes at the carrier level.
            </p>
          </div>
        )}

        {stageType === 'T0_RELEASE_ELIGIBLE' && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-xs text-red-200">
            <p className="font-semibold text-red-300">Release Eligibility Review</p>
            <p className="mt-1">
              Funding deadline <span className="font-semibold">{localizedDeadline}</span> has elapsed.
              The number is currently undergoing mandatory pre-release safety interlock checks.
              (Note: Provider release is gated OFF in production mode).
            </p>
          </div>
        )}
      </div>

      {/* Interactive CTAs */}
      {stageType !== 'FUNDED_ACTIVE' && stageType !== 'RELEASED' && (
        <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-slate-800 pt-4">
          <button
            onClick={handlePayClick}
            disabled={paymentProcessing}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white shadow hover:bg-emerald-500 transition-colors disabled:opacity-50"
          >
            {paymentProcessing ? 'Processing...' : 'Pay / Renew Now'}
          </button>

          <button
            onClick={handlePortOutAction}
            className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-slate-700 transition-colors"
          >
            Port Out Number
          </button>

          <button
            onClick={handleReleaseAction}
            className="rounded-lg border border-rose-900/50 bg-rose-950/30 px-4 py-2 text-xs font-medium text-rose-400 hover:bg-rose-900/40 transition-colors"
          >
            Release Number
          </button>
        </div>
      )}

      {/* Port Out Modal / Info Notice */}
      {showPortOutNotice && (
        <div className="mt-4 rounded-lg border border-slate-700 bg-slate-950 p-4 text-xs text-slate-300">
          <p className="font-semibold text-indigo-300">Port-Out Safety Information</p>
          <p className="mt-1">
            Initiating a port-out will automatically block automatic release of <span className="font-mono">{phoneNumberE164}</span>.
            However, VoIP Hub requires that funding remain active during the carrier transition period to prevent carrier loss.
          </p>
          <button
            onClick={() => setShowPortOutNotice(false)}
            className="mt-2 text-indigo-400 underline hover:text-indigo-300 text-[11px]"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Voluntary Release Modal */}
      {showReleaseModal && (
        <div className="mt-4 rounded-lg border border-rose-800 bg-slate-950 p-4 text-xs text-slate-300">
          <p className="font-semibold text-rose-400">Confirm Voluntary Release</p>
          <p className="mt-1">
            Voluntarily releasing <span className="font-mono">{phoneNumberE164}</span> requires multi-step confirmation and safety checks.
            (Simulated mode — live provider release mutation is gated OFF).
          </p>
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => setShowReleaseModal(false)}
              className="rounded bg-slate-800 px-3 py-1 text-slate-300 hover:bg-slate-700"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
