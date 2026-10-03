'use client';

import React, { useState, useEffect } from 'react';
import { AutoTopupStatusCustomerDto } from '@/lib/billing/creditAutoTopupService';
import { AutoTopupSetupModal } from './AutoTopupSetupModal';

interface AutoTopupCardProps {
  userRole?: string;
  onStatusChanged?: () => void;
}

export function AutoTopupCard({ userRole = 'agent', onStatusChanged }: AutoTopupCardProps) {
  const [settings, setSettings] = useState<AutoTopupStatusCustomerDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSetupOpen, setIsSetupOpen] = useState(false);
  const [disabling, setDisabling] = useState(false);

  const canManage = ['owner', 'admin'].includes(userRole.toLowerCase());

  const fetchSettings = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/billing/credit/auto-topup/settings');
      if (!res.ok) {
        throw new Error('Failed to load Auto Top-Up status');
      }
      const data = await res.json();
      if (data.success && data.settings) {
        setSettings(data.settings);
      }
    } catch (err: any) {
      setError(err.message || 'Error loading status');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSettings();
  }, []);

  const handleDisable = async () => {
    if (!canManage || disabling) return;
    if (!confirm('Are you sure you want to disable Auto Top-Up? Automatic recharges will stop.')) {
      return;
    }

    setDisabling(true);
    try {
      const res = await fetch('/api/billing/credit/auto-topup/settings', {
        method: 'DELETE',
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || 'Failed to disable Auto Top-Up');
      }
      await fetchSettings();
      if (onStatusChanged) onStatusChanged();
    } catch (err: any) {
      alert(err.message || 'Failed to disable Auto Top-Up');
    } finally {
      setDisabling(false);
    }
  };

  const handleModalSuccess = () => {
    setIsSetupOpen(false);
    fetchSettings();
    if (onStatusChanged) onStatusChanged();
  };

  if (loading) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-6 backdrop-blur-sm animate-pulse">
        <div className="h-5 w-48 bg-slate-800 rounded mb-4"></div>
        <div className="h-4 w-64 bg-slate-800/60 rounded"></div>
      </div>
    );
  }

  const isEnabled = settings?.enabled && settings?.status === 'enabled';
  const isActionRequired = settings?.status === 'action_required';
  const isPausedFailure = settings?.status === 'paused_failure';
  const isPausedDebt = settings?.status === 'paused_debt';

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-6 backdrop-blur-sm shadow-xl">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h3 className="text-lg font-semibold text-slate-100">Auto Top-Up</h3>
            {isEnabled && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400"></span>
                Active
              </span>
            )}
            {isActionRequired && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400"></span>
                Action Required
              </span>
            )}
            {(isPausedFailure || isPausedDebt) && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-rose-500/10 text-rose-400 border border-rose-500/20">
                <span className="h-1.5 w-1.5 rounded-full bg-rose-400"></span>
                Paused
              </span>
            )}
            {!isEnabled && !isActionRequired && !isPausedFailure && !isPausedDebt && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-800 text-slate-400 border border-slate-700">
                Disabled
              </span>
            )}
          </div>
          <p className="text-sm text-slate-400 mt-1">
            Automatically recharge credits when your spendable balance drops below a threshold.
          </p>
        </div>

        {canManage && (
          <div className="flex items-center gap-3 self-start sm:self-auto">
            {isEnabled || isActionRequired || isPausedFailure ? (
              <>
                <button
                  type="button"
                  onClick={() => setIsSetupOpen(true)}
                  className="px-4 py-2 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg transition-colors"
                >
                  Edit Settings
                </button>
                <button
                  type="button"
                  onClick={handleDisable}
                  disabled={disabling}
                  className="px-4 py-2 text-xs font-medium text-rose-400 hover:text-rose-300 bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/20 rounded-lg transition-colors disabled:opacity-50"
                >
                  {disabling ? 'Disabling...' : 'Disable'}
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setIsSetupOpen(true)}
                className="px-4 py-2 text-xs font-medium text-slate-900 bg-emerald-400 hover:bg-emerald-300 font-semibold rounded-lg transition-colors shadow-lg shadow-emerald-500/20"
              >
                Enable Auto Top-Up
              </button>
            )}
          </div>
        )}
      </div>

      {/* Settings Details Card */}
      {(isEnabled || isActionRequired || isPausedFailure || isPausedDebt) && (
        <div className="mt-6 pt-6 border-t border-slate-800/80 grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="bg-slate-950/40 p-3.5 rounded-lg border border-slate-800/50">
            <span className="text-xs text-slate-400 block font-medium">Recharge Threshold</span>
            <span className="text-base font-semibold text-slate-100 mt-0.5 block">
              ${settings?.thresholdMajor.toFixed(2)}
            </span>
            <span className="text-[11px] text-slate-500 mt-0.5 block">Recharge triggers below this</span>
          </div>

          <div className="bg-slate-950/40 p-3.5 rounded-lg border border-slate-800/50">
            <span className="text-xs text-slate-400 block font-medium">Auto Recharge Amount</span>
            <span className="text-base font-semibold text-slate-100 mt-0.5 block">
              +${settings?.rechargeAmountMajor.toFixed(2)}
            </span>
            <span className="text-[11px] text-slate-500 mt-0.5 block">Added on each recharge</span>
          </div>

          <div className="bg-slate-950/40 p-3.5 rounded-lg border border-slate-800/50">
            <span className="text-xs text-slate-400 block font-medium">Payment Method</span>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-300 px-1.5 py-0.5 bg-slate-800 rounded border border-slate-700">
                {settings?.paymentMethodBrand || 'CARD'}
              </span>
              <span className="text-sm text-slate-200 font-mono">•••• {settings?.paymentMethodLast4 || '****'}</span>
            </div>
          </div>
        </div>
      )}

      {/* Action Required Banner */}
      {isActionRequired && (
        <div className="mt-4 p-3.5 bg-amber-500/10 border border-amber-500/20 rounded-lg text-xs text-amber-300 flex items-start gap-2.5">
          <svg className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <div>
            <span className="font-semibold block">Card Re-Authorization Required</span>
            <span>
              {settings?.reason === 'PROVIDER_ACCOUNT_CHANGED'
                ? 'Your active billing provider configuration was updated. Please re-authorize your payment card.'
                : 'Payment method requires customer verification or card update.'}
            </span>
          </div>
        </div>
      )}

      {/* Modal Integration */}
      {isSetupOpen && (
        <AutoTopupSetupModal
          isOpen={isSetupOpen}
          initialThreshold={settings?.thresholdMajor || 10}
          initialRecharge={settings?.rechargeAmountMajor || 25}
          onClose={() => setIsSetupOpen(false)}
          onSuccess={handleModalSuccess}
        />
      )}
    </div>
  );
}
