'use client';

import React, { useState, useEffect } from 'react';
import { loadStripe, Stripe } from '@stripe/stripe-js';
import {
  Elements,
  PaymentElement,
  useStripe,
  useElements,
} from '@stripe/react-stripe-js';

// Initialize Stripe JS lazily outside component render
const stripePublishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || '';
let stripePromise: Promise<Stripe | null> | null = null;
if (stripePublishableKey) {
  stripePromise = loadStripe(stripePublishableKey);
}

export interface StripePaymentElementModalProps {
  isOpen: boolean;
  onClose: () => void;
  onPaymentSuccess?: (operationId: string) => void;
  selection: {
    phoneNumber: string;
    countryCode: string;
    numberType: string;
    monthlyRetailMinor?: number;
    currency?: string;
    bundleSid?: string | null;
  } | null;
}

function CheckoutFormContent({
  selection,
  operationId,
  priceSummary,
  onClose,
  onSuccess,
}: {
  selection: StripePaymentElementModalProps['selection'];
  operationId: string;
  priceSummary: {
    monthlyRetailMinor: number;
    currency: string;
    taxStatus: string;
  };
  onClose: () => void;
  onSuccess: (opId: string) => void;
}) {
  const stripe = useStripe();
  const elements = useElements();

  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [consentSavedMethod, setConsentSavedMethod] = useState(false);

  const formattedAmount = (priceSummary.monthlyRetailMinor / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: priceSummary.currency || 'USD',
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!stripe || !elements) {
      return;
    }

    setIsProcessing(true);
    setErrorMessage(null);

    try {
      // Trigger Stripe payment confirmation in manual capture mode
      const { error, paymentIntent } = await stripe.confirmPayment({
        elements,
        confirmParams: {
          return_url: typeof window !== 'undefined' ? `${window.location.origin}/numbers/marketplace?status=authorized` : '',
        },
        redirect: 'if_required',
      });

      if (error) {
        setErrorMessage(error.message || 'Payment authorization failed. Please check card details and try again.');
        setIsProcessing(false);
      } else if (paymentIntent) {
        if (paymentIntent.status === 'requires_capture' || paymentIntent.status === 'succeeded') {
          setIsProcessing(false);
          onSuccess(operationId);
        } else if (paymentIntent.status === 'requires_action') {
          setErrorMessage('Additional authentication required. Please follow the prompt.');
          setIsProcessing(false);
        } else {
          setErrorMessage(`Payment authorization status: ${paymentIntent.status}`);
          setIsProcessing(false);
        }
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'An unexpected error occurred during payment authorization.');
      setIsProcessing(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Order Summary */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 space-y-3">
        <div className="flex justify-between items-center text-sm border-b border-slate-800 pb-2">
          <span className="text-slate-400">Selected Line</span>
          <span className="font-mono text-white font-medium">{selection?.phoneNumber}</span>
        </div>
        <div className="flex justify-between items-center text-sm border-b border-slate-800 pb-2">
          <span className="text-slate-400">Region & Category</span>
          <span className="text-slate-200 capitalize">
            {selection?.countryCode} • {selection?.numberType?.replace('_', ' ')}
          </span>
        </div>
        <div className="flex justify-between items-center text-sm border-b border-slate-800 pb-2">
          <span className="text-slate-400">Billing Interval</span>
          <span className="text-slate-200">Monthly Recurring</span>
        </div>
        <div className="flex justify-between items-center text-sm border-b border-slate-800 pb-2">
          <span className="text-slate-400">Tax Status</span>
          <span className="text-xs text-amber-400/90 font-medium">{priceSummary.taxStatus}</span>
        </div>
        <div className="flex justify-between items-center text-base pt-1 font-semibold">
          <span className="text-white">Total Amount to Authorize</span>
          <span className="text-emerald-400">{formattedAmount}</span>
        </div>
      </div>

      {/* Stripe Payment Element Container */}
      <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-4">
        <PaymentElement
          options={{
            layout: 'tabs',
          }}
        />
      </div>

      {/* Explicit Saved Payment Method Consent Checkbox (Section H) */}
      <div className="flex items-start space-x-3 text-xs text-slate-300 bg-slate-900/40 p-3 rounded-lg border border-slate-800">
        <input
          type="checkbox"
          id="consentSavedMethod"
          checked={consentSavedMethod}
          onChange={(e) => setConsentSavedMethod(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-slate-700 bg-slate-800 text-indigo-600 focus:ring-indigo-500"
        />
        <label htmlFor="consentSavedMethod" className="cursor-pointer leading-relaxed">
          I authorize Kripscall to save this payment method and automatically bill <span className="text-white font-medium">{formattedAmount}/month</span> for recurring subscription line renewals until canceled.
        </label>
      </div>

      {/* Error Message */}
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
          className="px-4 py-2.5 text-sm font-medium text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg transition disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!stripe || !elements || isProcessing}
          className="px-6 py-2.5 text-sm font-semibold text-white bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 rounded-lg shadow-lg shadow-indigo-600/20 transition disabled:opacity-50 flex items-center space-x-2"
        >
          {isProcessing ? (
            <>
              <svg className="animate-spin h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <span>Authorizing...</span>
            </>
          ) : (
            <span>Authorize Payment ({formattedAmount})</span>
          )}
        </button>
      </div>
    </form>
  );
}

export function StripePaymentElementModal({
  isOpen,
  onClose,
  onPaymentSuccess,
  selection,
}: StripePaymentElementModalProps) {
  const [loadingSession, setLoadingSession] = useState(false);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [priceSummary, setPriceSummary] = useState<{
    monthlyRetailMinor: number;
    currency: string;
    taxStatus: string;
  }>({
    monthlyRetailMinor: selection?.monthlyRetailMinor || 315,
    currency: selection?.currency || 'USD',
    taxStatus: 'Tax not collected (merchant registration pending)',
  });

  useEffect(() => {
    if (!isOpen || !selection) {
      setClientSecret(null);
      setOperationId(null);
      setSessionError(null);
      return;
    }

    let isMounted = true;
    async function initSession() {
      setLoadingSession(true);
      setSessionError(null);

      try {
        const res = await fetch('/api/billing/checkout/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            phoneNumber: selection?.phoneNumber,
            countryCode: selection?.countryCode,
            numberType: selection?.numberType,
            expectedPriceMinor: selection?.monthlyRetailMinor,
            bundleSid: selection?.bundleSid,
          }),
        });

        const data = await res.json();
        if (!isMounted) return;

        if (!res.ok || !data.success) {
          setSessionError(data.message || data.error || 'Failed to initialize checkout session.');
          setLoadingSession(false);
          return;
        }

        setClientSecret(data.clientSecret || null);
        setOperationId(data.operationId || null);
        if (data.priceSummary) {
          setPriceSummary(data.priceSummary);
        }
        setLoadingSession(false);
      } catch (err: any) {
        if (!isMounted) return;
        setSessionError(err.message || 'Network error initializing checkout session.');
        setLoadingSession(false);
      }
    }

    initSession();

    return () => {
      isMounted = false;
    };
  }, [isOpen, selection]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="relative w-full max-w-lg bg-slate-950 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-900/50">
          <div>
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <span>🔒</span> Secure Payment Authorization
            </h2>
            <p className="text-xs text-slate-400">Stripe Test Mode • Pre-Authorization Hold</p>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1 rounded-lg transition"
          >
            ✕
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6 overflow-y-auto flex-1">
          {loadingSession ? (
            <div className="py-12 text-center space-y-3">
              <div className="inline-block animate-spin rounded-full h-8 w-8 border-2 border-indigo-500 border-t-transparent" />
              <p className="text-sm text-slate-300 font-medium">Preparing secure checkout session...</p>
              <p className="text-xs text-slate-400">Verifying pricing, availability, and regulatory compliance</p>
            </div>
          ) : sessionError ? (
            <div className="py-8 text-center space-y-4">
              <div className="mx-auto w-12 h-12 bg-rose-500/20 text-rose-400 rounded-full flex items-center justify-center text-2xl font-bold">
                !
              </div>
              <h3 className="text-base font-semibold text-white">Checkout Initialization Issue</h3>
              <p className="text-sm text-rose-300 max-w-sm mx-auto">{sessionError}</p>
              <button
                onClick={onClose}
                className="px-5 py-2 text-sm font-medium text-white bg-slate-800 hover:bg-slate-700 rounded-lg transition"
              >
                Close
              </button>
            </div>
          ) : clientSecret && stripePromise && operationId ? (
            <Elements
              stripe={stripePromise}
              options={{
                clientSecret,
                appearance: {
                  theme: 'night',
                  variables: {
                    colorPrimary: '#6366f1',
                    colorBackground: '#090d16',
                    colorText: '#f8fafc',
                  },
                },
              }}
            >
              <CheckoutFormContent
                selection={selection}
                operationId={operationId}
                priceSummary={priceSummary}
                onClose={onClose}
                onSuccess={(opId) => {
                  if (onPaymentSuccess) onPaymentSuccess(opId);
                  onClose();
                }}
              />
            </Elements>
          ) : (
            <div className="py-8 text-center space-y-3 text-slate-400 text-sm">
              <p>Stripe publishable key is not configured for test mode.</p>
              <button
                onClick={onClose}
                className="px-4 py-2 text-xs font-medium text-white bg-slate-800 hover:bg-slate-700 rounded-lg"
              >
                Close
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
