'use client';

import React, { useState, useEffect } from 'react';
import { loadStripe, Stripe } from '@stripe/stripe-js';
import {
  Elements,
  PaymentElement,
  useStripe,
  useElements,
} from '@stripe/react-stripe-js';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { ShieldCheck, Loader2, AlertCircle, CheckCircle, CreditCard, Info } from 'lucide-react';

const stripePublishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || '';
let stripePromise: Promise<Stripe | null> | null = null;
if (stripePublishableKey) {
  stripePromise = loadStripe(stripePublishableKey);
}

export interface NumberRenewalSetupModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  phoneNumberId?: string;
  billableResourceId?: string;
  phoneNumber?: string;
}

function RenewalSetupForm({
  attemptToken,
  setupIntentId,
  phoneNumber,
  onClose,
  onSuccess,
}: {
  attemptToken: string;
  setupIntentId: string;
  phoneNumber?: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();

  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [consentAccepted, setConsentAccepted] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!stripe || !elements) {
      return;
    }

    if (!consentAccepted) {
      setErrorMessage('Explicit authorization is required before saving a payment method.');
      return;
    }

    setIsProcessing(true);
    setErrorMessage(null);

    try {
      // 1. Confirm SetupIntent client-side through Stripe Elements
      const { error, setupIntent } = await stripe.confirmSetup({
        elements,
        confirmParams: {
          return_url: typeof window !== 'undefined' ? `${window.location.origin}/billing/numbers?status=setup_complete` : '',
        },
        redirect: 'if_required',
      });

      if (error) {
        setErrorMessage(error.message || 'Setup confirmation failed. Please check card details.');
        setIsProcessing(false);
        return;
      }

      if (setupIntent && setupIntent.status === 'succeeded') {
        // 2. Complete setup and persist explicit consent on server
        const completeRes = await fetch('/api/billing/numbers/renewal-setup-intent', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            attemptToken,
            setupIntentId: setupIntent.id,
            consentAccepted: true,
          }),
        });

        const completeData = await completeRes.json();

        if (!completeRes.ok || !completeData.success) {
          setErrorMessage(completeData.message || 'Failed to record payment consent.');
          setIsProcessing(false);
          return;
        }

        setIsProcessing(false);
        onSuccess();
      } else if (setupIntent && setupIntent.status === 'requires_action') {
        setErrorMessage('Additional authentication required. Please follow the prompt.');
        setIsProcessing(false);
      } else {
        setErrorMessage(`Setup status: ${setupIntent?.status || 'unknown'}`);
        setIsProcessing(false);
      }
    } catch (err: any) {
      console.error('[RenewalSetupForm] Error confirming setup:', err.message || err);
      setErrorMessage(err.message || 'An unexpected error occurred during payment setup.');
      setIsProcessing(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Scope & Authorization Header */}
      <div className="p-3.5 rounded-lg bg-indigo-500/10 border border-indigo-500/20 space-y-1 text-xs">
        <div className="font-semibold text-indigo-900 dark:text-indigo-200 flex items-center gap-1.5">
          <ShieldCheck className="w-4 h-4 text-indigo-500" />
          <span>Phone Number Rental Renewal Authorization</span>
        </div>
        <p className="text-slate-600 dark:text-slate-400">
          Target line: <span className="font-mono font-medium text-slate-900 dark:text-slate-100">{phoneNumber || 'Workspace Phone Number'}</span>
        </p>
      </div>

      {/* Stripe Payment Element */}
      <div className="p-3 bg-slate-50 dark:bg-slate-900/50 rounded-lg border border-slate-200 dark:border-slate-800">
        <PaymentElement />
      </div>

      {/* Dynamic Renewal Wording & Explicit Consent Checkbox */}
      <div className="p-3.5 rounded-lg bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-2 text-xs">
        <div className="flex items-start gap-2">
          <input
            type="checkbox"
            id="renewal-consent-checkbox"
            checked={consentAccepted}
            onChange={(e) => setConsentAccepted(e.target.checked)}
            className="mt-0.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
          />
          <label htmlFor="renewal-consent-checkbox" className="font-medium text-slate-900 dark:text-slate-100 cursor-pointer leading-tight">
            I authorize VoIP Hub to save this payment method and charge it automatically for future phone number rental renewals.
          </label>
        </div>
        <div className="flex items-start gap-1.5 text-[11px] text-slate-500 dark:text-slate-400 pl-5">
          <Info className="w-3.5 h-3.5 text-indigo-500 shrink-0 mt-0.5" />
          <span>
            Upcoming rental cycles are dynamically calculated based on current provider carrier costs plus VoIP Hub&apos;s configured number rental pricing policy. Current baseline: $3.15 USD/month.
          </span>
        </div>
      </div>

      {errorMessage && (
        <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-400 text-xs flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* Footer Buttons */}
      <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
        <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={isProcessing}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={!stripe || !elements || !consentAccepted || isProcessing}
        >
          {isProcessing ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
              <span>Saving Payment Method...</span>
            </>
          ) : (
            <>
              <CreditCard className="w-3.5 h-3.5 mr-1.5" />
              <span>Save Renewal Payment Method</span>
            </>
          )}
        </Button>
      </div>
    </form>
  );
}

export function NumberRenewalSetupModal({
  isOpen,
  onClose,
  onSuccess,
  phoneNumberId,
  billableResourceId,
  phoneNumber,
}: NumberRenewalSetupModalProps) {
  const [initLoading, setInitLoading] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [attemptToken, setAttemptToken] = useState<string | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [setupIntentId, setSetupIntentId] = useState<string | null>(null);
  const [isSuccess, setIsSuccess] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setAttemptToken(null);
      setClientSecret(null);
      setSetupIntentId(null);
      setInitError(null);
      setIsSuccess(false);
      return;
    }

    async function initSetupIntent() {
      setInitLoading(true);
      setInitError(null);

      try {
        const res = await fetch('/api/billing/numbers/renewal-setup-intent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            phoneNumberId,
            billableResourceId,
          }),
        });

        const data = await res.json();

        if (!res.ok || !data.success) {
          const rawMsg = data.message || '';
          console.error('[NumberRenewalSetupModal] Initialization failed:', rawMsg);
          const safeMsg = rawMsg.includes('is not a function') || rawMsg.includes('TypeError')
            ? 'Unable to load the payment setup securely. Please try again.'
            : rawMsg || 'Unable to load the payment setup securely. Please try again.';
          setInitError(safeMsg);
          setInitLoading(false);
          return;
        }

        setAttemptToken(data.attemptToken);
        setClientSecret(data.clientSecret);
        setSetupIntentId(data.setupIntentId);
      } catch (err: any) {
        console.error('[NumberRenewalSetupModal] Init error:', err.message || err);
        setInitError(err.message || 'Network error initializing setup.');
      } finally {
        setInitLoading(false);
      }
    }

    initSetupIntent();
  }, [isOpen, phoneNumberId, billableResourceId]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-md bg-white dark:bg-slate-950 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden">
        {/* Modal Header */}
        <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CreditCard className="w-5 h-5 text-indigo-500" />
            <h3 className="font-bold text-sm text-slate-900 dark:text-slate-100">
              Setup Renewal Payment Method
            </h3>
          </div>
          <Badge variant="blue" className="text-[10px]">
            TEST MODE
          </Badge>
        </div>

        {/* Body Content */}
        <div className="p-5 space-y-4">
          {initLoading ? (
            <div className="py-12 text-center space-y-3">
              <Loader2 className="w-8 h-8 animate-spin text-indigo-500 mx-auto" />
              <p className="text-xs text-slate-500">Initializing secure payment setup...</p>
            </div>
          ) : initError ? (
            <div className="py-6 text-center space-y-3">
              <AlertCircle className="w-8 h-8 text-rose-500 mx-auto" />
              <p className="text-xs text-rose-600 dark:text-rose-400 font-medium">{initError}</p>
              <Button variant="outline" size="sm" onClick={onClose}>
                Close
              </Button>
            </div>
          ) : isSuccess ? (
            <div className="py-8 text-center space-y-3">
              <CheckCircle className="w-10 h-10 text-emerald-500 mx-auto" />
              <h4 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                Payment Identity Authorized
              </h4>
              <p className="text-xs text-slate-500 dark:text-slate-400 max-w-xs mx-auto">
                Off-session payment method saved for recurring phone-number rental renewals.
              </p>
              <div className="pt-2">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    onSuccess?.();
                    onClose();
                  }}
                >
                  Done
                </Button>
              </div>
            </div>
          ) : clientSecret && attemptToken && setupIntentId && stripePromise ? (
            <Elements stripe={stripePromise} options={{ clientSecret, appearance: { theme: 'stripe' } }}>
              <RenewalSetupForm
                attemptToken={attemptToken}
                setupIntentId={setupIntentId}
                phoneNumber={phoneNumber}
                onClose={onClose}
                onSuccess={() => setIsSuccess(true)}
              />
            </Elements>
          ) : (
            <div className="py-6 text-center space-y-2">
              <p className="text-xs text-slate-500">Stripe configuration unavailable in test environment.</p>
              <Button variant="outline" size="sm" onClick={onClose}>
                Close
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
