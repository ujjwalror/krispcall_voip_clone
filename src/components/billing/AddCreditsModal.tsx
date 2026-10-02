'use client';

import React, { useState, useEffect, useId } from 'react';
import { loadStripe, Stripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { Zap, ShieldCheck, AlertTriangle, Loader2, CheckCircle2, ArrowLeft, Clock } from 'lucide-react';
import {
  MIN_TOPUP_MAJOR,
  MAX_TOPUP_MAJOR,
  PRESET_TOPUP_MAJOR,
  DEFAULT_TOPUP_MAJOR,
  majorToMinorUnits,
  validateTopupAmountMajor,
} from '@/lib/billing/creditTopupPolicy';
import { formatMinorUnitsToCurrency } from '@/lib/billing/currencyFormatter';

const stripePublishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || '';
let stripePromise: Promise<Stripe | null> | null = null;
if (stripePublishableKey) {
  stripePromise = loadStripe(stripePublishableKey);
}

export interface AddCreditsModalProps {
  isOpen: boolean;
  onClose: () => void;
  currency?: string;
  onPaymentSuccess?: () => void;
  prePaymentBalanceMinor?: number;
}

interface CheckoutData {
  paymentOperationId: string;
  clientSecret: string;
  amountMinor: number;
  formattedAmount: string;
  currency: string;
}

function StripeCheckoutForm({
  checkoutData,
  onBack,
  onStripeSuccess,
}: {
  checkoutData: CheckoutData;
  onBack: () => void;
  onStripeSuccess: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements || isProcessing) return;

    setIsProcessing(true);
    setErrorMessage(null);

    try {
      const { error, paymentIntent } = await stripe.confirmPayment({
        elements,
        confirmParams: {
          return_url: typeof window !== 'undefined' ? `${window.location.origin}/billing/credit?status=processing` : '',
        },
        redirect: 'if_required',
      });

      if (error) {
        setErrorMessage(error.message || 'Payment confirmation failed. Please check your payment details.');
        setIsProcessing(false);
      } else if (paymentIntent) {
        if (paymentIntent.status === 'succeeded' || paymentIntent.status === 'requires_capture') {
          setIsProcessing(false);
          onStripeSuccess();
        } else if (paymentIntent.status === 'requires_action') {
          setErrorMessage('Additional payment authentication required.');
          setIsProcessing(false);
        } else {
          setErrorMessage(`Payment status: ${paymentIntent.status}`);
          setIsProcessing(false);
        }
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'An unexpected error occurred during payment processing.');
      setIsProcessing(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 space-y-2">
        <div className="flex justify-between items-center text-xs text-slate-400">
          <span>Top-Up Amount</span>
          <span className="font-bold text-white text-sm">{checkoutData.formattedAmount}</span>
        </div>
        <div className="flex justify-between items-center text-[11px] text-slate-400">
          <span>Item</span>
          <span className="text-amber-400 font-medium">Prepaid Calling Credits</span>
        </div>
      </div>

      <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-4">
        <PaymentElement options={{ layout: 'tabs' }} />
      </div>

      {errorMessage && (
        <div className="p-3 bg-rose-500/10 border border-rose-500/30 rounded-lg text-rose-400 text-xs flex items-start space-x-2">
          <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400 mt-0.5" />
          <span>{errorMessage}</span>
        </div>
      )}

      <div className="flex items-center justify-between pt-2">
        <button
          type="button"
          onClick={onBack}
          disabled={isProcessing}
          className="px-4 py-2 text-xs font-semibold text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg transition disabled:opacity-50 flex items-center gap-1.5"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Change Amount</span>
        </button>
        <button
          type="submit"
          disabled={!stripe || !elements || isProcessing}
          className="px-6 py-2.5 text-xs font-bold text-slate-950 bg-gradient-to-r from-amber-400 to-amber-500 hover:from-amber-300 hover:to-amber-400 rounded-lg shadow-lg shadow-amber-500/20 transition disabled:opacity-50 flex items-center gap-2"
        >
          {isProcessing ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin text-slate-950" />
              <span>Processing...</span>
            </>
          ) : (
            <span>Pay {checkoutData.formattedAmount}</span>
          )}
        </button>
      </div>
    </form>
  );
}

export function AddCreditsModal({
  isOpen,
  onClose,
  currency = 'USD',
  onPaymentSuccess,
  prePaymentBalanceMinor = 0,
}: AddCreditsModalProps) {
  const [step, setStep] = useState<'amount' | 'payment' | 'verifying' | 'success' | 'pending_webhook'>('amount');
  const [selectedMajor, setSelectedMajor] = useState<number>(DEFAULT_TOPUP_MAJOR);
  const [customMajorInput, setCustomMajorInput] = useState<string>('');
  const [isCustom, setIsCustom] = useState<boolean>(false);

  const [attemptToken, setAttemptToken] = useState<string>('');
  const [checkoutData, setCheckoutData] = useState<CheckoutData | null>(null);
  const [isLoadingCheckout, setIsLoadingCheckout] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const customInputId = useId();

  // Reset modal state on open
  useEffect(() => {
    if (isOpen) {
      setStep('amount');
      setSelectedMajor(DEFAULT_TOPUP_MAJOR);
      setCustomMajorInput('');
      setIsCustom(false);
      setAttemptToken(typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : '00000000-0000-4000-8000-000000000000');
      setCheckoutData(null);
      setIsLoadingCheckout(false);
      setErrorMsg(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const currentMajor = isCustom ? parseFloat(customMajorInput) || 0 : selectedMajor;
  const validation = validateTopupAmountMajor(currentMajor, currency);

  const handleInitiateCheckout = async () => {
    if (!validation.valid || !validation.amountMinor) {
      setErrorMsg(validation.message || 'Invalid amount selected.');
      return;
    }

    setIsLoadingCheckout(true);
    setErrorMsg(null);

    // Ensure we have a valid attempt token
    let token = attemptToken;
    if (!token) {
      token = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : '00000000-0000-4000-8000-000000000000';
      setAttemptToken(token);
    }

    try {
      const res = await fetch('/api/billing/credit/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          attemptToken: token,
          amountMinor: validation.amountMinor,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success || !data.clientSecret) {
        throw new Error(data.message || data.error || 'Failed to initialize checkout session.');
      }

      setCheckoutData({
        paymentOperationId: data.paymentOperationId,
        clientSecret: data.clientSecret,
        amountMinor: data.amountMinor,
        formattedAmount: data.formattedAmount,
        currency: data.currency,
      });
      setStep('payment');
    } catch (err: any) {
      setErrorMsg(err.message || 'Checkout initialization failed. Please try again.');
    } finally {
      setIsLoadingCheckout(false);
    }
  };

  const handleStripeSuccess = async () => {
    setStep('verifying');

    // Poll authoritative summary & history until balance updates
    const startTime = Date.now();
    const timeoutMs = 30000;
    const intervalMs = 2000;

    const checkAuthoritativeUpdate = async (): Promise<boolean> => {
      try {
        const res = await fetch('/api/billing/credit/summary', {
          headers: { 'Cache-Control': 'no-cache' },
        });
        if (res.ok) {
          const summary = await res.json();
          if (summary.availableCreditsMinor > prePaymentBalanceMinor) {
            return true;
          }
        }
      } catch (e) {
        // ignore polling error
      }
      return false;
    };

    const poll = async () => {
      const isFunded = await checkAuthoritativeUpdate();
      if (isFunded) {
        setStep('success');
        if (onPaymentSuccess) onPaymentSuccess();
        return;
      }

      if (Date.now() - startTime < timeoutMs) {
        setTimeout(poll, intervalMs);
      } else {
        // Timeout: Show delayed webhook processing state
        setStep('pending_webhook');
      }
    };

    poll();
  };

  const minFormatted = formatMinorUnitsToCurrency(majorToMinorUnits(MIN_TOPUP_MAJOR, currency), currency);
  const maxFormatted = formatMinorUnitsToCurrency(majorToMinorUnits(MAX_TOPUP_MAJOR, currency), currency);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl space-y-0">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-slate-800 bg-slate-950/40">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-xl bg-amber-500/10 text-amber-500 border border-amber-500/20">
              <Zap className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-100">Add Calling Credits</h2>
              <p className="text-[11px] text-slate-400">Prepaid balance for outbound & incoming PSTN usage</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 text-xs px-2 py-1 rounded-lg border border-slate-800 hover:bg-slate-800"
          >
            ✕
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6">
          {step === 'amount' && (
            <div className="space-y-6">
              {/* Presets */}
              <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-300 block">Select Top-Up Amount ({currency})</label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {PRESET_TOPUP_MAJOR.map((preset) => {
                    const presetFormatted = formatMinorUnitsToCurrency(majorToMinorUnits(preset, currency), currency);
                    const isSelected = !isCustom && selectedMajor === preset;
                    return (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => {
                          setIsCustom(false);
                          setSelectedMajor(preset);
                          setErrorMsg(null);
                        }}
                        className={`py-3 px-2 rounded-xl border text-xs font-semibold transition flex flex-col items-center justify-center gap-0.5 ${
                          isSelected
                            ? 'border-amber-500 bg-amber-500/10 text-amber-300 shadow-md shadow-amber-500/10'
                            : 'border-slate-800 bg-slate-950/50 text-slate-300 hover:border-slate-700 hover:bg-slate-800/60'
                        }`}
                      >
                        <span className="text-sm font-bold">{presetFormatted}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Custom Amount */}
              <div className="space-y-2 pt-1 border-t border-slate-800/60">
                <div className="flex justify-between items-center text-xs">
                  <label htmlFor={customInputId} className="font-semibold text-slate-300">Or Enter Custom Amount ({currency})</label>
                  <span className="text-[11px] text-slate-400">
                    Min {minFormatted} • Max {maxFormatted}
                  </span>
                </div>
                <div className="relative">
                  <input
                    id={customInputId}
                    type="number"
                    min={MIN_TOPUP_MAJOR}
                    max={MAX_TOPUP_MAJOR}
                    step="1"
                    placeholder={`e.g. 75 (${currency})`}
                    value={customMajorInput}
                    onChange={(e) => {
                      setIsCustom(true);
                      setCustomMajorInput(e.target.value);
                      setErrorMsg(null);
                      // Generate new token if amount is explicitly changed by user
                      setAttemptToken(typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : '00000000-0000-4000-8000-000000000000');
                    }}
                    className={`w-full bg-slate-950/80 border rounded-xl px-4 py-2.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-amber-500/50 ${
                      isCustom ? 'border-amber-500/60' : 'border-slate-800'
                    }`}
                  />
                </div>
              </div>

              {errorMsg && (
                <div className="p-3 bg-rose-500/10 border border-rose-500/30 rounded-lg text-rose-400 text-xs flex items-start space-x-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400 mt-0.5" />
                  <span>{errorMsg}</span>
                </div>
              )}

              {/* Actions */}
              <div className="flex items-center justify-between pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2.5 text-xs font-semibold text-slate-400 hover:text-slate-200"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleInitiateCheckout}
                  disabled={!validation.valid || isLoadingCheckout}
                  className="px-6 py-2.5 text-xs font-bold text-slate-950 bg-gradient-to-r from-amber-400 to-amber-500 hover:from-amber-300 hover:to-amber-400 rounded-xl shadow-lg shadow-amber-500/20 transition disabled:opacity-50 flex items-center gap-2"
                >
                  {isLoadingCheckout ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin text-slate-950" />
                      <span>Initializing...</span>
                    </>
                  ) : (
                    <span>
                      Continue to Payment ({formatMinorUnitsToCurrency(validation.amountMinor || 0, currency)})
                    </span>
                  )}
                </button>
              </div>
            </div>
          )}

          {step === 'payment' && checkoutData && (
            <Elements
              stripe={stripePromise}
              options={{
                clientSecret: checkoutData.clientSecret,
                appearance: { theme: 'night' },
              }}
            >
              <StripeCheckoutForm
                checkoutData={checkoutData}
                onBack={() => {
                  setStep('amount');
                  // Changing amount starts a new logical attempt
                  setAttemptToken(typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : '00000000-0000-4000-8000-000000000000');
                }}
                onStripeSuccess={handleStripeSuccess}
              />
            </Elements>
          )}

          {step === 'verifying' && (
            <div className="py-8 text-center space-y-4">
              <Loader2 className="w-8 h-8 animate-spin text-amber-500 mx-auto" />
              <div>
                <h3 className="text-sm font-bold text-slate-100">Verifying Available Credits</h3>
                <p className="text-xs text-slate-400 mt-1">
                  Payment received by Stripe. Confirming exact-once backend funding...
                </p>
              </div>
            </div>
          )}

          {step === 'success' && (
            <div className="py-8 text-center space-y-4">
              <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto" />
              <div>
                <h3 className="text-base font-bold text-slate-100">Credits Added Successfully!</h3>
                <p className="text-xs text-slate-400 mt-1 max-w-sm mx-auto">
                  Your prepaid calling balance and transaction history have been authoritatively updated.
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="px-6 py-2.5 text-xs font-bold text-slate-950 bg-emerald-400 hover:bg-emerald-300 rounded-xl transition shadow-lg shadow-emerald-500/20"
              >
                Done
              </button>
            </div>
          )}

          {step === 'pending_webhook' && (
            <div className="py-6 text-center space-y-4">
              <Clock className="w-10 h-10 text-amber-400 mx-auto" />
              <div>
                <h3 className="text-sm font-bold text-slate-100">Payment Processing</h3>
                <p className="text-xs text-slate-400 mt-1 max-w-sm mx-auto">
                  Your payment was received by Stripe and is being processed by backend webhooks. Your Credits will update automatically once confirmed.
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="px-6 py-2 text-xs font-semibold text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-xl transition"
              >
                Close
              </button>
            </div>
          )}
        </div>

        {/* Footer info */}
        <div className="p-3 bg-slate-950/60 border-t border-slate-800/80 text-[10px] text-slate-500 flex items-center justify-between">
          <span className="flex items-center gap-1">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
            <span>256-Bit Encrypted Secure Billing</span>
          </span>
          <span>Authoritative Exact-Once Settlement</span>
        </div>
      </div>
    </div>
  );
}
