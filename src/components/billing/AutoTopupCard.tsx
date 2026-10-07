'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import {
  Zap,
  CreditCard,
  AlertCircle,
  Loader2,
  Settings,
  ExternalLink,
} from 'lucide-react';
import { AutoTopupStatusCustomerDto } from '@/lib/billing/creditAutoTopupService';
import { WorkspacePaymentProfileDTO } from '@/lib/billing/workspacePaymentProfileService';

interface AutoTopupCardProps {
  userRole?: string;
  onStatusChanged?: () => void;
}

const PRESET_THRESHOLDS = [10, 25, 50, 100];
const PRESET_RECHARGES = [25, 50, 100, 250];

export function AutoTopupCard({ userRole = 'agent', onStatusChanged }: AutoTopupCardProps) {
  const [settings, setSettings] = useState<AutoTopupStatusCustomerDto | null>(null);
  const [paymentProfile, setPaymentProfile] = useState<WorkspacePaymentProfileDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDisabling, setIsDisabling] = useState(false);

  // Editing form state
  const [thresholdMajor, setThresholdMajor] = useState<number>(10);
  const [rechargeAmountMajor, setRechargeAmountMajor] = useState<number>(25);
  const [consentAgreed, setConsentAgreed] = useState<boolean>(true);

  const canManage = ['owner', 'admin'].includes(userRole.toLowerCase());

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [settingsRes, profileRes] = await Promise.all([
        fetch('/api/billing/credit/auto-topup/settings', { cache: 'no-store' }),
        fetch('/api/billing/workspace-payment-profile', { cache: 'no-store' }),
      ]);

      if (!settingsRes.ok) {
        throw new Error('Failed to load Auto Top-Up settings');
      }

      const settingsData = await settingsRes.json();
      if (settingsData.success && settingsData.settings) {
        setSettings(settingsData.settings);
        setThresholdMajor(settingsData.settings.thresholdMajor || 10);
        setRechargeAmountMajor(settingsData.settings.rechargeAmountMajor || 25);
      }

      if (profileRes.ok) {
        const profileData: WorkspacePaymentProfileDTO = await profileRes.json();
        setPaymentProfile(profileData);
      }
    } catch (err: any) {
      console.error('[AutoTopupCard] Error loading state:', err.message || err);
      setError(err.message || 'Error loading status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleSaveChanges = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!canManage || isSaving) return;

    if (!paymentProfile?.hasDefaultPaymentMethod) {
      setError('A workspace default payment method is required before enabling Auto Top-Up.');
      return;
    }

    if (!consentAgreed) {
      setError('You must authorize Auto Top-Up to enable automatic recharges.');
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      const res = await fetch('/api/billing/credit/auto-topup/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          thresholdMajor,
          rechargeAmountMajor,
          enabled: true,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.message || data.error || 'Failed to update Auto Top-Up settings.');
      }

      setIsEditing(false);
      await fetchData();
      if (onStatusChanged) onStatusChanged();
    } catch (err: any) {
      console.error('[AutoTopupCard] Save error:', err.message || err);
      setError(err.message || 'Failed to update Auto Top-Up settings.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDisable = async () => {
    if (!canManage || isDisabling) return;
    if (!confirm('Are you sure you want to disable Auto Top-Up? Automatic credit recharges will stop.')) {
      return;
    }

    setIsDisabling(true);
    setError(null);

    try {
      const res = await fetch('/api/billing/credit/auto-topup/settings', {
        method: 'DELETE',
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || 'Failed to disable Auto Top-Up');
      }

      setIsEditing(false);
      await fetchData();
      if (onStatusChanged) onStatusChanged();
    } catch (err: any) {
      console.error('[AutoTopupCard] Disable error:', err.message || err);
      setError(err.message || 'Failed to disable Auto Top-Up.');
    } finally {
      setIsDisabling(false);
    }
  };

  if (loading) {
    return (
      <Card className="p-6">
        <div className="flex items-center gap-3">
          <Loader2 className="w-5 h-5 animate-spin text-amber-500" />
          <span className="text-xs text-slate-500">Loading Auto Top-Up configuration...</span>
        </div>
      </Card>
    );
  }

  const isRawEnabled = settings?.enabled && settings?.status === 'enabled';
  const hasCard = paymentProfile?.hasDefaultPaymentMethod;
  const isOperationallyActive = isRawEnabled && hasCard;

  const cardSummary = paymentProfile?.paymentMethod
    ? `${paymentProfile.paymentMethod.brand.toUpperCase()} •••• ${paymentProfile.paymentMethod.last4}`
    : 'No saved card';

  return (
    <Card className="border-slate-200 dark:border-slate-800">
      <CardHeader className="pb-3 flex flex-row items-center justify-between">
        <div className="flex items-center gap-2">
          <Zap className="w-4 h-4 text-amber-500" />
          <CardTitle className="text-sm">Auto Top-Up</CardTitle>
          {isOperationallyActive ? (
            <Badge variant="emerald" className="text-[10px]">
              ACTIVE
            </Badge>
          ) : !hasCard ? (
            <Badge variant="amber" className="text-[10px]">
              PAYMENT METHOD REQUIRED
            </Badge>
          ) : (
            <Badge variant="neutral" className="text-[10px]">
              DISABLED
            </Badge>
          )}
        </div>

        {canManage && (
          <div>
            {isOperationallyActive && !isEditing && (
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setIsEditing(true)}
                  className="text-xs"
                >
                  <Settings className="w-3.5 h-3.5 mr-1" />
                  Edit
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={handleDisable}
                  disabled={isDisabling}
                  className="text-xs"
                >
                  {isDisabling ? 'Disabling...' : 'Disable'}
                </Button>
              </div>
            )}
          </div>
        )}
      </CardHeader>

      <div className="p-4 pt-0 space-y-4 text-xs">
        <p className="text-slate-500 dark:text-slate-400">
          Automatically add credit to your telecom wallet whenever spendable balance drops below a set threshold.
        </p>

        {error && (
          <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-400 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* STATE 1: NO SAVED PAYMENT METHOD (DEPENDENCY STATE) */}
        {!hasCard ? (
          <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-900 dark:text-amber-200 space-y-3">
            <div className="flex items-center gap-2 font-semibold text-sm">
              <CreditCard className="w-4 h-4 text-amber-500 shrink-0" />
              <span>Payment method required</span>
            </div>
            <p className="text-[11px] text-amber-800/80 dark:text-amber-300/80">
              Add a workspace payment method under Plan &amp; Subscription before enabling Auto Top-Up.
            </p>
            <div>
              <Link href="/settings/billing?tab=payment-methods">
                <Button variant="primary" size="sm" className="mt-1">
                  <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
                  Go to Payment Methods
                </Button>
              </Link>
            </div>
          </div>
        ) : isEditing || !isRawEnabled ? (
          /* STATE 2: COMPACT CONFIGURATION FORM (WITH SAVED CARD) */
          <form onSubmit={handleSaveChanges} className="space-y-4 pt-1">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Threshold Selection */}
              <div className="space-y-1.5">
                <label className="font-medium text-slate-700 dark:text-slate-300">
                  When balance falls below
                </label>
                <select
                  value={thresholdMajor}
                  onChange={(e) => setThresholdMajor(Number(e.target.value))}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 font-medium focus:ring-2 focus:ring-amber-500"
                >
                  {PRESET_THRESHOLDS.map((amt) => (
                    <option key={amt} value={amt}>
                      ${amt}.00 USD
                    </option>
                  ))}
                </select>
              </div>

              {/* Recharge Amount Selection */}
              <div className="space-y-1.5">
                <label className="font-medium text-slate-700 dark:text-slate-300">
                  Automatically add credit
                </label>
                <select
                  value={rechargeAmountMajor}
                  onChange={(e) => setRechargeAmountMajor(Number(e.target.value))}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 font-medium focus:ring-2 focus:ring-amber-500"
                >
                  {PRESET_RECHARGES.map((amt) => (
                    <option key={amt} value={amt}>
                      ${amt}.00 USD
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Masked Payment Method Summary */}
            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CreditCard className="w-4 h-4 text-slate-400" />
                <span className="text-slate-500">Payment method:</span>
                <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                  {cardSummary}
                </span>
              </div>
              <Link href="/settings/billing?tab=payment-methods">
                <span className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline flex items-center gap-1">
                  <span>Manage</span>
                  <ExternalLink className="w-3 h-3" />
                </span>
              </Link>
            </div>

            {/* Explicit Authorization Consent */}
            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 flex items-start gap-2.5">
              <input
                type="checkbox"
                id="walletConsent"
                checked={consentAgreed}
                onChange={(e) => setConsentAgreed(e.target.checked)}
                className="mt-0.5 rounded border-slate-300 text-amber-600 focus:ring-amber-500"
              />
              <label htmlFor="walletConsent" className="text-[11px] text-slate-600 dark:text-slate-300 cursor-pointer leading-relaxed">
                I authorize VoIP Hub to automatically charge <span className="font-semibold text-slate-900 dark:text-slate-100">${rechargeAmountMajor}.00 USD</span> to <span className="font-mono font-semibold">{cardSummary}</span> whenever workspace credit balance falls below <span className="font-semibold text-slate-900 dark:text-slate-100">${thresholdMajor}.00 USD</span>.
              </label>
            </div>

            {/* Action Buttons */}
            {canManage && (
              <div className="flex items-center justify-end gap-2 pt-1">
                {isOperationallyActive && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setIsEditing(false)}
                    disabled={isSaving}
                  >
                    Cancel
                  </Button>
                )}
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  disabled={!consentAgreed || isSaving}
                >
                  {isSaving ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
                      <span>Saving...</span>
                    </>
                  ) : (
                    <span>{isOperationallyActive ? 'Save Changes' : 'Enable Auto Top-Up'}</span>
                  )}
                </Button>
              </div>
            )}
          </form>
        ) : (
          /* STATE 3: ACTIVE AUTO TOP-UP SUMMARY */
          <div className="space-y-3 pt-1">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                <span className="text-[11px] text-slate-500 block">Trigger Threshold</span>
                <span className="text-base font-bold text-slate-900 dark:text-slate-100 mt-0.5 block">
                  ${settings?.thresholdMajor.toFixed(2)} USD
                </span>
                <span className="text-[10px] text-slate-400 mt-0.5 block">Triggers when balance &lt; this</span>
              </div>

              <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                <span className="text-[11px] text-slate-500 block">Recharge Amount</span>
                <span className="text-base font-bold text-emerald-600 dark:text-emerald-400 mt-0.5 block">
                  +${settings?.rechargeAmountMajor.toFixed(2)} USD
                </span>
                <span className="text-[10px] text-slate-400 mt-0.5 block">Added per trigger event</span>
              </div>

              <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                <span className="text-[11px] text-slate-500 block">Payment Method</span>
                <div className="font-mono font-semibold text-slate-900 dark:text-slate-100 mt-1 flex items-center justify-between">
                  <span>{cardSummary}</span>
                  <Link href="/settings/billing?tab=payment-methods">
                    <span className="text-[10px] text-indigo-600 dark:text-indigo-400 font-sans hover:underline ml-1">
                      Manage
                    </span>
                  </Link>
                </div>
                <span className="text-[10px] text-slate-400 mt-0.5 block">Workspace default card</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
