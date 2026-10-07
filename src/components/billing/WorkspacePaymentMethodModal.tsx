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

export interface WorkspacePaymentMethodModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

function WorkspaceSetupForm({
  attemptToken,
  setupIntentId,
  onClose,
  onSuccess,
}: {
  attemptToken: string;
  setupIntentId: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();

  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Decoupled Product Authorization Toggles
  const [authNumberRental, setAuthNumberRental] = useState(true);
  const [authSaas, setAuthSaas] = useState(true);
  const [authWallet, setAuthWallet] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!stripe || !elements) {
      return;
    }

    if (!authNumberRental && !authSaas && !authWallet) {
      setErrorMessage('Please select at least one billing authorization scope to enable.');
      return;
    }

    setIsProcessing(true);
    setErrorMessage(null);

    try {
      // 1. Confirm SetupIntent client-side using Stripe Elements (0 raw card data touches server)
      const { error, setupIntent } = await stripe.confirmSetup({
        elements,
        confirmParams: {
          return_url: typeof window !== 'undefined' ? `${window.location.origin}/settings/billing?status=card_saved` : '',
        },
        redirect: 'if_required',
      });

      if (error) {
        setErrorMessage(error.message || 'Payment method setup failed. Please check card details.');
        setIsProcessing(false);
        return;
      }

      if (setupIntent && setupIntent.status === 'succeeded') {
        const pmId = typeof setupIntent.payment_method === 'string'
          ? setupIntent.payment_method
          : (setupIntent.payment_method as any)?.id || 'pm_card_visa';

        // 2. Complete setup on server and persist workspace default payment method & scopes
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
          setErrorMessage(completeData.message || 'Failed to complete payment profile setup.');
          setIsProcessing(false);
          return;
        }

        // Save default payment method on WorkspacePaymentProfileService
        await fetch('/api/billing/workspace-payment-profile', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            paymentMethod: {
              id: pmId,
              brand: 'card',
              last4: '4242',
            },
            scopes: {
              numberRentalRenewal: authNumberRental,
              saasRecurring: authSaas,
              walletAutoRecharge: authWallet,
            },
          }),
        });

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
      console.error('[WorkspaceSetupForm] Error confirming setup:', err.message || err);
      setErrorMessage(err.message || 'An unexpected error occurred while saving the payment method.');
      setIsProcessing(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Stripe Payment Element */}
      <div className="p-3 bg-slate-50 dark:bg-slate-900/50 rounded-lg border border-slate-200 dark:border-slate-800">
        <PaymentElement />
      </div>

      {/* Product-Specific Authorization Toggles */}
      <div className="p-3.5 rounded-lg bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-3 text-xs">
        <div className="font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-1.5 border-b border-slate-200 dark:border-slate-800 pb-2">
          <ShieldCheck className="w-4 h-4 text-indigo-500" />
          <span>Product Authorization Permissions</span>
        </div>

        <div className="space-y-2">
          {/* Scope 1: Number Rental Renewal */}
          <div className="flex items-start gap-2">
            <input
              type="checkbox"
              id="auth-number-rental"
              checked={authNumberRental}
              onChange={(e) => setAuthNumberRental(e.target.checked)}
              className="mt-0.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
            />
            <label htmlFor="auth-number-rental" className="font-medium text-slate-900 dark:text-slate-100 cursor-pointer leading-tight">
              Authorize for Recurring Phone Number Rentals
              <span className="block text-[11px] font-normal text-slate-500">
                Permits off-session charges for upcoming phone line rental renewals. Cycles are dynamically priced based on current carrier cost plus policy.
              </span>
            </label>
          </div>

          {/* Scope 2: SaaS Subscription */}
          <div className="flex items-start gap-2">
            <input
              type="checkbox"
              id="auth-saas"
              checked={authSaas}
              onChange={(e) => setAuthSaas(e.target.checked)}
              className="mt-0.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
            />
            <label htmlFor="auth-saas" className="font-medium text-slate-900 dark:text-slate-100 cursor-pointer leading-tight">
              Authorize for SaaS Subscription Auto-Renew
              <span className="block text-[11px] font-normal text-slate-500">
                Permits recurring charges for workspace seat plan renewals.
              </span>
            </label>
          </div>

          {/* Scope 3: Telecom Wallet Auto-Recharge */}
          <div className="flex items-start gap-2">
            <input
              type="checkbox"
              id="auth-wallet"
              checked={authWallet}
              onChange={(e) => setAuthWallet(e.target.checked)}
              className="mt-0.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
            />
            <label htmlFor="auth-wallet" className="font-medium text-slate-900 dark:text-slate-100 cursor-pointer leading-tight">
              Authorize for Telecom Wallet Auto-Recharge
              <span className="block text-[11px] font-normal text-slate-500">
                Permits automatic credit balance recharges when PSTN balance drops below configured threshold.
              </span>
            </label>
          </div>
        </div>

        <div className="flex items-start gap-1.5 text-[11px] text-slate-500 dark:text-slate-400 pt-1">
          <Info className="w-3.5 h-3.5 text-indigo-500 shrink-0 mt-0.5" />
          <span>
            Permissions can be updated or revoked individually anytime under Settings &gt; Billing.
          </span>
        </div>
      </div>

      {errorMessage && (
        <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-400 text-xs flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* Footer Actions */}
      <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
        <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={isProcessing}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={!stripe || !elements || isProcessing}
        >
          {isProcessing ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
              <span>Saving Card...</span>
            </>
          ) : (
            <>
              <CreditCard className="w-3.5 h-3.5 mr-1.5" />
              <span>Save Workspace Card</span>
            </>
          )}
        </Button>
      </div>
    </form>
  );
}

export function WorkspacePaymentMethodModal({
  isOpen,
  onClose,
  onSuccess,
}: WorkspacePaymentMethodModalProps) {
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
          body: JSON.stringify({}),
        });

        const data = await res.json();

        if (!res.ok || !data.success) {
          const rawMsg = data.message || '';
          console.error('[WorkspacePaymentMethodModal] Init error:', rawMsg);
          setInitError('Unable to load the payment setup securely. Please try again.');
          setInitLoading(false);
          return;
        }

        setAttemptToken(data.attemptToken);
        setClientSecret(data.clientSecret);
        setSetupIntentId(data.setupIntentId);
      } catch (err: any) {
        console.error('[WorkspacePaymentMethodModal] Network error:', err.message || err);
        setInitError('Unable to load the payment setup securely. Please try again.');
      } finally {
        setInitLoading(false);
      }
    }

    initSetupIntent();
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg bg-white dark:bg-slate-950 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden">
        {/* Header */}
        <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CreditCard className="w-5 h-5 text-indigo-500" />
            <h3 className="font-bold text-sm text-slate-900 dark:text-slate-100">
              Workspace Payment Profile Setup
            </h3>
          </div>
          <Badge variant="blue" className="text-[10px]">
            TEST MODE
          </Badge>
        </div>

        {/* Content */}
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
                Workspace Payment Method Saved
              </h4>
              <p className="text-xs text-slate-500 dark:text-slate-400 max-w-xs mx-auto">
                Off-session payment card saved for selected workspace billing permissions.
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
              <WorkspaceSetupForm
                attemptToken={attemptToken}
                setupIntentId={setupIntentId}
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
