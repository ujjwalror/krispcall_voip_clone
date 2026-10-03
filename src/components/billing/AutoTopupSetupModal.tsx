'use client';

import React, { useState, useEffect } from 'react';
import { loadStripe, Stripe } from '@stripe/stripe-js';
import {
  Elements,
  PaymentElement,
  useStripe,
  useElements,
} from '@stripe/react-stripe-js';
import {
  PRESET_AUTO_TOPUP_THRESHOLDS_MAJOR,
  PRESET_AUTO_TOPUP_RECHARGES_MAJOR,
  DEFAULT_AUTO_TOPUP_THRESHOLD_MAJOR,
  DEFAULT_AUTO_TOPUP_RECHARGE_MAJOR,
} from '@/lib/billing/autoTopupPolicy';

const stripePublishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || '';
let stripePromise: Promise<Stripe | null> | null = null;
if (stripePublishableKey) {
  stripePromise = loadStripe(stripePublishableKey);
}

export interface AutoTopupSetupModalProps {
  isOpen: boolean;
  initialThreshold?: number;
  initialRecharge?: number;
  onClose: () => void;
  onSuccess: () => void;
}

function SetupFormContent({
  thresholdMajor,
  rechargeAmountMajor,
  setupIntentId,
  onClose,
  onSuccess,
}: {
  thresholdMajor: number;
  rechargeAmountMajor: number;
  setupIntentId: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();

  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [consentAgreed, setConsentAgreed] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!stripe || !elements) return;
    if (!consentAgreed) {
      setErrorMessage('Please agree to the Auto Top-Up authorization terms.');
      return;
    }

    setIsProcessing(true);
    setErrorMessage(null);

    try {
      // 1. Confirm SetupIntent on Stripe client
      const { error, setupIntent } = await stripe.confirmSetup({
        elements,
        confirmParams: {
          return_url: typeof window !== 'undefined' ? `${window.location.origin}/billing/credit?status=auto_topup_setup` : '',
        },
        redirect: 'if_required',
      });

      if (error) {
        setErrorMessage(error.message || 'Payment method setup failed. Please check details and try again.');
        setIsProcessing(false);
        return;
      }

      if (setupIntent && setupIntent.status === 'succeeded') {
        // 2. Complete enrolment on server
        const res = await fetch('/api/billing/credit/auto-topup/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            setupIntentId: setupIntent.id,
            thresholdMajor,
            rechargeAmountMajor,
          }),
        });

        const data = await res.json();
        if (!res.ok || !data.success) {
          setErrorMessage(data.message || data.error || 'Failed to save Auto Top-Up enrolment.');
          setIsProcessing(false);
          return;
        }

        setIsProcessing(false);
        onSuccess();
      } else if (setupIntent && setupIntent.status === 'requires_action') {
        setErrorMessage('Additional card authentication required. Please follow the prompt.');
        setIsProcessing(false);
      } else {
        setErrorMessage(`Setup status: ${setupIntent?.status || 'unknown'}`);
        setIsProcessing(false);
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'An unexpected error occurred during setup.');
      setIsProcessing(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Summary */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 space-y-2 text-xs text-slate-300">
        <div className="flex justify-between items-center pb-2 border-b border-slate-800">
          <span className="text-slate-400">Trigger Threshold</span>
          <span className="font-medium text-white">${thresholdMajor.toFixed(2)}</span>
        </div>
        <div className="flex justify-between items-center pb-2 border-b border-slate-800">
          <span className="text-slate-400">Recharge Amount</span>
          <span className="font-medium text-emerald-400">+${rechargeAmountMajor.toFixed(2)}</span>
        </div>
        <div className="flex justify-between items-center pt-1 text-slate-400">
          <span>Initial Charge</span>
          <span className="text-white font-semibold">$0.00 (Setup Only)</span>
        </div>
      </div>

      {/* Stripe Payment Element */}
      <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-4">
        <PaymentElement options={{ layout: 'tabs' }} />
      </div>

      {/* Explicit Consent Checkbox */}
      <div className="flex items-start space-x-3 text-xs text-slate-300 bg-slate-900/40 p-3 rounded-lg border border-slate-800">
        <input
          type="checkbox"
          id="autoTopupConsent"
          checked={consentAgreed}
          onChange={(e) => setConsentAgreed(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-slate-700 bg-slate-800 text-emerald-600 focus:ring-emerald-500"
        />
        <label htmlFor="autoTopupConsent" className="cursor-pointer leading-relaxed">
          I authorize Kripscall to save this payment method and automatically charge <span className="text-emerald-400 font-semibold">+${rechargeAmountMajor.toFixed(2)}</span> whenever spendable credit balance drops below <span className="text-white font-medium">${thresholdMajor.toFixed(2)}</span>. I understand I can disable Auto Top-Up at any time.
        </label>
      </div>

      {/* Error */}
      {errorMessage && (
        <div className="p-3 bg-rose-500/10 border border-rose-500/30 rounded-lg text-rose-400 text-xs flex items-start space-x-2">
          <span className="font-bold">⚠️</span>
          <span>{errorMessage}</span>
        </div>
      )}

      {/* Actions */}
      <div className="flex justify-end space-x-3 pt-2">
        <button
          type="button"
          onClick={onClose}
          disabled={isProcessing}
          className="px-4 py-2 text-xs font-medium text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg transition disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!stripe || !elements || !consentAgreed || isProcessing}
          className="px-5 py-2 text-xs font-semibold text-slate-900 bg-emerald-400 hover:bg-emerald-300 rounded-lg shadow-lg shadow-emerald-500/20 transition disabled:opacity-50 flex items-center space-x-2"
        >
          {isProcessing ? (
            <>
              <svg className="animate-spin h-3.5 w-3.5 text-slate-900" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <span>Verifying & Saving...</span>
            </>
          ) : (
            <span>Save & Enable Auto Top-Up</span>
          )}
        </button>
      </div>
    </form>
  );
}

export function AutoTopupSetupModal({
  isOpen,
  initialThreshold = DEFAULT_AUTO_TOPUP_THRESHOLD_MAJOR,
  initialRecharge = DEFAULT_AUTO_TOPUP_RECHARGE_MAJOR,
  onClose,
  onSuccess,
}: AutoTopupSetupModalProps) {
  const [step, setStep] = useState<'config' | 'stripe'>('config');
  const [thresholdMajor, setThresholdMajor] = useState(initialThreshold);
  const [rechargeAmountMajor, setRechargeAmountMajor] = useState(initialRecharge);

  const [loadingSetup, setLoadingSetup] = useState(false);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [setupIntentId, setSetupIntentId] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setStep('config');
      setClientSecret(null);
      setSetupIntentId(null);
      setSetupError(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleStartStripeSetup = async () => {
    setLoadingSetup(true);
    setSetupError(null);

    try {
      const res = await fetch('/api/billing/credit/auto-topup/setup-intent', {
        method: 'POST',
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        setSetupError(data.message || data.error || 'Failed to initialize SetupIntent.');
        setLoadingSetup(false);
        return;
      }

      setClientSecret(data.clientSecret);
      setSetupIntentId(data.setupIntentId);
      setStep('stripe');
      setLoadingSetup(false);
    } catch (err: any) {
      setSetupError(err.message || 'Network error initializing payment method setup.');
      setLoadingSetup(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="relative w-full max-w-lg bg-slate-950 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-900/50">
          <div>
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              <span>⚙️</span> Auto Top-Up Configuration
            </h2>
            <p className="text-xs text-slate-400">Step {step === 'config' ? '1 of 2: Thresholds' : '2 of 2: Payment Method'}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white p-1 rounded-lg transition">
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="p-6 overflow-y-auto flex-1">
          {step === 'config' ? (
            <div className="space-y-6">
              {/* Threshold Selection */}
              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-2">
                  When spendable credit balance drops below:
                </label>
                <div className="grid grid-cols-3 gap-2 mb-3">
                  {PRESET_AUTO_TOPUP_THRESHOLDS_MAJOR.map((val) => (
                    <button
                      key={val}
                      type="button"
                      onClick={() => setThresholdMajor(val)}
                      className={`py-2 px-3 rounded-lg text-xs font-semibold border transition ${
                        thresholdMajor === val
                          ? 'bg-indigo-600/20 text-indigo-400 border-indigo-500'
                          : 'bg-slate-900 text-slate-300 border-slate-800 hover:bg-slate-800'
                      }`}
                    >
                      ${val.toFixed(2)}
                    </button>
                  ))}
                </div>
              </div>

              {/* Recharge Amount Selection */}
              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-2">
                  Automatically recharge this amount:
                </label>
                <div className="grid grid-cols-3 gap-2 mb-3">
                  {PRESET_AUTO_TOPUP_RECHARGES_MAJOR.map((val) => (
                    <button
                      key={val}
                      type="button"
                      onClick={() => setRechargeAmountMajor(val)}
                      className={`py-2 px-3 rounded-lg text-xs font-semibold border transition ${
                        rechargeAmountMajor === val
                          ? 'bg-emerald-600/20 text-emerald-400 border-emerald-500'
                          : 'bg-slate-900 text-slate-300 border-slate-800 hover:bg-slate-800'
                      }`}
                    >
                      +${val.toFixed(2)}
                    </button>
                  ))}
                </div>
              </div>

              {setupError && (
                <div className="p-3 bg-rose-500/10 border border-rose-500/30 rounded-lg text-rose-400 text-xs">
                  {setupError}
                </div>
              )}

              {/* Footer Actions */}
              <div className="flex justify-end space-x-3 pt-4 border-t border-slate-800">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 text-xs font-medium text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleStartStripeSetup}
                  disabled={loadingSetup}
                  className="px-5 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg shadow-lg shadow-indigo-600/20 transition disabled:opacity-50 flex items-center gap-2"
                >
                  {loadingSetup ? (
                    <>
                      <span className="animate-spin h-3.5 w-3.5 border-2 border-white border-t-transparent rounded-full" />
                      <span>Initializing...</span>
                    </>
                  ) : (
                    <span>Next: Add Payment Method →</span>
                  )}
                </button>
              </div>
            </div>
          ) : clientSecret && stripePromise && setupIntentId ? (
            <Elements
              stripe={stripePromise}
              options={{
                clientSecret,
                appearance: {
                  theme: 'night',
                  variables: { colorPrimary: '#10b981', colorBackground: '#090d16', colorText: '#f8fafc' },
                },
              }}
            >
              <SetupFormContent
                thresholdMajor={thresholdMajor}
                rechargeAmountMajor={rechargeAmountMajor}
                setupIntentId={setupIntentId}
                onClose={onClose}
                onSuccess={onSuccess}
              />
            </Elements>
          ) : (
            <div className="py-8 text-center text-xs text-slate-400">
              Initializing payment elements...
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
