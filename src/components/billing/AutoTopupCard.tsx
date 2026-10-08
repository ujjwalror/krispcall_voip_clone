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
  ExternalLink,
  Check,
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

  const [isSaving, setIsSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);

  // Auto Top-Up form values
  const [enabledState, setEnabledState] = useState<boolean>(false);
  const [thresholdMajor, setThresholdMajor] = useState<number>(10);
  const [rechargeAmountMajor, setRechargeAmountMajor] = useState<number>(25);

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
        const isEnabled = settingsData.settings.enabled && settingsData.settings.status === 'enabled';
        setEnabledState(isEnabled);
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
      setIsDirty(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const hasCard = paymentProfile?.hasDefaultPaymentMethod;
  const isOperationallyActive = enabledState && hasCard;

  const cardSummary = paymentProfile?.paymentMethod
    ? `${paymentProfile.paymentMethod.brand.toUpperCase()} •••• ${paymentProfile.paymentMethod.last4}`
    : 'No saved card';

  const handleToggle = async (nextState: boolean) => {
    if (!canManage) return;

    if (nextState && !hasCard) {
      setError('A workspace payment method is required under Plan & Subscription to enable Auto Top-Up.');
      return;
    }

    setEnabledState(nextState);
    setIsDirty(true);
  };

  const handleSaveChanges = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!canManage || isSaving) return;

    if (enabledState && !hasCard) {
      setError('A workspace payment method is required under Plan & Subscription before enabling Auto Top-Up.');
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
          enabled: enabledState,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.message || data.error || 'Failed to update Auto Top-Up settings.');
      }

      await fetchData();
      if (onStatusChanged) onStatusChanged();
    } catch (err: any) {
      console.error('[AutoTopupCard] Save error:', err.message || err);
      setError(err.message || 'Failed to update Auto Top-Up settings.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    if (settings) {
      const isEnabled = settings.enabled && settings.status === 'enabled';
      setEnabledState(isEnabled);
      setThresholdMajor(settings.thresholdMajor || 10);
      setRechargeAmountMajor(settings.rechargeAmountMajor || 25);
    }
    setIsDirty(false);
    setError(null);
  };

  if (loading) {
    return (
      <Card className="p-6 w-full">
        <div className="flex items-center gap-3">
          <Loader2 className="w-5 h-5 animate-spin text-amber-500" />
          <span className="text-xs text-slate-500">Loading Auto Top-Up configuration...</span>
        </div>
      </Card>
    );
  }

  return (
    <Card className="w-full border-slate-200 dark:border-slate-800">
      <CardHeader className="pb-3 border-b border-slate-100 dark:border-slate-800/60 flex flex-row items-center justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5">
            <Zap className="w-5 h-5 text-amber-500" />
            <CardTitle className="text-base font-bold text-slate-900 dark:text-slate-100">
              Auto Top-Up
            </CardTitle>
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
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Automatically add credit to your telecom wallet when your available balance falls below the amount you set.
          </p>
        </div>

        {/* ON / OFF Toggle Switch */}
        {canManage && (
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs font-semibold text-slate-600 dark:text-slate-400">
              {enabledState ? 'ON' : 'OFF'}
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={enabledState}
              onClick={() => handleToggle(!enabledState)}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2 ${
                enabledState ? 'bg-amber-500' : 'bg-slate-300 dark:bg-slate-700'
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                  enabledState ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>
        )}
      </CardHeader>

      <div className="p-5 space-y-5 text-xs">
        {error && (
          <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-400 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Inline No Payment Method Notification if card is missing */}
        {!hasCard && (
          <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-900 dark:text-amber-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-2 font-medium">
              <CreditCard className="w-4 h-4 text-amber-500 shrink-0" />
              <span>Add a workspace payment method to enable Auto Top-Up.</span>
            </div>
            <Link href="/settings/billing?tab=payment-methods">
              <Button variant="primary" size="sm" className="shrink-0 text-xs">
                <span>Manage Payment Method</span>
                <ExternalLink className="w-3.5 h-3.5 ml-1" />
              </Button>
            </Link>
          </div>
        )}

        {/* Configuration Selectors */}
        <form onSubmit={handleSaveChanges} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Threshold Selector */}
            <div className="space-y-1.5">
              <label className="font-semibold text-slate-700 dark:text-slate-300 block">
                When balance is less than or equal to
              </label>
              <select
                value={thresholdMajor}
                onChange={(e) => {
                  setThresholdMajor(Number(e.target.value));
                  setIsDirty(true);
                }}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 font-medium focus:ring-2 focus:ring-amber-500"
              >
                {PRESET_THRESHOLDS.map((amt) => (
                  <option key={amt} value={amt}>
                    ${amt}.00 USD
                  </option>
                ))}
              </select>
            </div>

            {/* Recharge Amount Selector */}
            <div className="space-y-1.5">
              <label className="font-semibold text-slate-700 dark:text-slate-300 block">
                Automatically add
              </label>
              <select
                value={rechargeAmountMajor}
                onChange={(e) => {
                  setRechargeAmountMajor(Number(e.target.value));
                  setIsDirty(true);
                }}
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

          {/* Masked Workspace Payment Method Reference */}
          <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <CreditCard className="w-4 h-4 text-slate-400 shrink-0" />
              <span className="text-slate-500">Payment method:</span>
              <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                {cardSummary}
              </span>
            </div>
            <Link href="/settings/billing?tab=payment-methods">
              <span className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline flex items-center gap-1">
                <span>Manage</span>
                <ExternalLink className="w-3 h-3" />
              </span>
            </Link>
          </div>

          {/* Action Buttons */}
          {canManage && (
            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800/60">
              {isDirty && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleCancel}
                  disabled={isSaving}
                >
                  Cancel
                </Button>
              )}
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={!isDirty || isSaving}
              >
                {isSaving ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
                    <span>Saving...</span>
                  </>
                ) : (
                  <>
                    <Check className="w-3.5 h-3.5 mr-1" />
                    <span>Save Changes</span>
                  </>
                )}
              </Button>
            </div>
          )}
        </form>
      </div>
    </Card>
  );
}
