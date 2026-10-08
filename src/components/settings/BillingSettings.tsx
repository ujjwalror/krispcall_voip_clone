'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import {
  CreditCard,
  Receipt,
  Sparkles,
  Users,
  AlertTriangle,
  Loader2,
  RefreshCw,
  Building,
  Zap,
  Phone,
  Clock,
  Info,
  Lock,
  Calendar,
  CheckCircle2,
  FileText,
  Plus,
  Shield,
  Sliders,
} from 'lucide-react';
import { useAuth } from '@/components/providers/AuthProvider';
import { WorkspacePaymentMethodModal } from '@/components/billing/WorkspacePaymentMethodModal';
import type { WorkspacePaymentProfileDTO } from '@/lib/billing/workspacePaymentProfileService';

export interface SubscriptionSummary {
  status: string;
  plan: {
    code: string;
    name: string;
    description: string | null;
    isPublic: boolean;
  };
  price: {
    id: string;
    currency: string;
    billingInterval: 'monthly' | 'annual';
    pricingModel: string;
    unitAmountMinor: string | null;
    baseAmountMinor: string | null;
  } | null;
  period: {
    start: string | null;
    end: string | null;
    hasFutureBoundary: boolean;
  };
  cancellation: {
    scheduledAtPeriodEnd: boolean;
    canceledAt: string | null;
    endedAt: string | null;
  };
  seats: {
    active: number;
    included: number | null;
    maximum: number | null;
  };
  recurringCostPreview: {
    currency: string;
    amountMinor: string | null;
    isCalculable: boolean;
    pricingModel: string;
  } | null;
  isInternalNonBillable: boolean;
}

/**
 * Precision-safe helper to format minor units string (e.g., "1500" -> "$15.00")
 * Uses actual API currency parameter dynamically. Avoids floating-point arithmetic.
 */
function formatMinorUnitsToCurrencyString(amountMinorStr: string | null, currency: string = 'USD'): string {
  if (!amountMinorStr) {
    return 'N/A';
  }
  try {
    const minorBig = BigInt(amountMinorStr);
    const dollars = minorBig / BigInt(100);
    const cents = minorBig % BigInt(100);
    const centsStr = cents.toString().padStart(2, '0');
    const symbol = currency.toUpperCase() === 'USD' ? '$' : `${currency.toUpperCase()} `;
    return `${symbol}${dollars.toLocaleString()}.${centsStr}`;
  } catch {
    return `${currency.toUpperCase()} ${amountMinorStr}`;
  }
}

export function BillingSettings() {
  const { profile, organization } = useAuth();
  const [data, setData] = useState<SubscriptionSummary | null>(null);
  const [paymentProfile, setPaymentProfile] = useState<WorkspacePaymentProfileDTO | null>(null);
  const [isCardModalOpen, setIsCardModalOpen] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Modals & Action States
  const [isCancelModalOpen, setIsCancelModalOpen] = useState<boolean>(false);
  const [isPlanModalOpen, setIsPlanModalOpen] = useState<boolean>(false);
  const [isSubmittingAction, setIsSubmittingAction] = useState<boolean>(false);
  const [actionNotice, setActionNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const handleCancelSubscription = async () => {
    setIsSubmittingAction(true);
    setActionNotice(null);
    try {
      const res = await fetch('/api/billing/subscription/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const resData = await res.json();
      if (res.ok && resData.result?.success) {
        setActionNotice({
          type: 'success',
          message: resData.result.message || 'Subscription cancellation scheduled at period end.',
        });
        setIsCancelModalOpen(false);
        fetchSubscription();
      } else {
        setActionNotice({
          type: 'error',
          message: resData.message || 'Failed to cancel subscription.',
        });
      }
    } catch (err: any) {
      setActionNotice({
        type: 'error',
        message: 'Network error processing cancellation request.',
      });
    } finally {
      setIsSubmittingAction(false);
    }
  };

  const handleReactivateSubscription = async () => {
    setIsSubmittingAction(true);
    setActionNotice(null);
    try {
      const res = await fetch('/api/billing/subscription/reactivate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const resData = await res.json();
      if (res.ok && resData.result?.success) {
        setActionNotice({
          type: 'success',
          message: resData.result.message || 'Subscription successfully reactivated.',
        });
        fetchSubscription();
      } else {
        setActionNotice({
          type: 'error',
          message: resData.message || 'Failed to reactivate subscription.',
        });
      }
    } catch (err: any) {
      setActionNotice({
        type: 'error',
        message: 'Network error processing reactivation request.',
      });
    } finally {
      setIsSubmittingAction(false);
    }
  };

  // Tab State: 'overview' | 'plans' | 'info' | 'payments' | 'invoices'
  const [activeTab, setActiveTab] = useState<'overview' | 'plans' | 'info' | 'payments' | 'invoices'>('overview');
  const [isAnnualBilling, setIsAnnualBilling] = useState<boolean>(false);
  const [downgradeCheckState, setDowngradeCheckState] = useState<{
    targetPlanCode: string;
    loading: boolean;
    result: any;
  } | null>(null);

  const handleCheckDowngrade = async (targetPlanCode: string) => {
    setDowngradeCheckState({ targetPlanCode, loading: true, result: null });
    try {
      const res = await fetch('/api/billing/downgrade-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetPlanCode }),
      });
      const data = await res.json();
      setDowngradeCheckState({ targetPlanCode, loading: false, result: data.eligibility || null });
    } catch (err: any) {
      setDowngradeCheckState({
        targetPlanCode,
        loading: false,
        result: { allowed: false, reason: 'Failed to evaluate downgrade eligibility. Network error.' },
      });
    }
  };

  const fetchPaymentProfile = useCallback(async () => {
    try {
      const res = await fetch('/api/billing/workspace-payment-profile', { cache: 'no-store' });
      if (res.ok) {
        const json = await res.json();
        setPaymentProfile(json);
      }
    } catch (err) {
      console.error('[BillingSettings] Error fetching payment profile:', err);
    }
  }, []);

  const fetchSubscription = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/billing/subscription', { cache: 'no-store' });
      if (res.ok) {
        const json = await res.json();
        setData(json.subscription || null);
      } else {
        const errJson = await res.json().catch(() => ({}));
        setError(errJson.message || 'Failed to retrieve subscription summary.');
      }
      await fetchPaymentProfile();
    } catch (err) {
      console.error('[BillingSettings] Error fetching subscription summary:', err);
      setError('Network error loading subscription summary. Please try again.');
    } finally {
      setIsLoading(false);
    }
  }, [fetchPaymentProfile]);

  useEffect(() => {
    fetchSubscription();
  }, [fetchSubscription]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const tabParam = params.get('tab');
      if (tabParam === 'payment-methods' || tabParam === 'payments') {
        setActiveTab('payments');
      } else if (tabParam === 'info') {
        setActiveTab('info');
      } else if (tabParam === 'invoices') {
        setActiveTab('invoices');
      }
    }
  }, []);

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 space-y-4 max-w-4xl mx-auto">
        <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
        <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">
          Loading subscription & billing overview...
        </p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <Card className="border-rose-200 dark:border-rose-900/50 bg-rose-50/50 dark:bg-rose-950/20 max-w-4xl mx-auto">
        <div className="flex items-start gap-3 p-4">
          <AlertTriangle className="w-5 h-5 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
          <div className="flex-1">
            <h4 className="text-sm font-semibold text-rose-900 dark:text-rose-200">
              Unable to load billing details
            </h4>
            <p className="text-xs text-rose-700 dark:text-rose-300 mt-1">
              {error || 'No subscription data returned for this workspace.'}
            </p>
            <Button
              onClick={fetchSubscription}
              variant="outline"
              className="mt-3 text-xs border-rose-300 dark:border-rose-800 text-rose-700 dark:text-rose-200 hover:bg-rose-100 dark:hover:bg-rose-900/40"
            >
              <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
              Retry Loading
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  const { plan, price, period, cancellation, seats, recurringCostPreview, isInternalNonBillable } = data;

  // Format period boundary date if present
  const formattedPeriodEnd = period.end
    ? new Date(period.end).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : null;

  // Calculate dynamic seat usage percentage if maximum is a valid positive number
  const seatPercentage =
    seats.maximum && seats.maximum > 0
      ? Math.min(100, Math.round((seats.active / seats.maximum) * 1000) / 10)
      : null;

  return (
    <div className="space-y-6 max-w-5xl mx-auto pb-16">
      {/* PAGE HEADER */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            <span>Plan & Subscription</span>
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Manage your workspace subscription, seats and billing information.
          </p>
        </div>

        {/* Change Plan & Subscription Lifecycle Top Header Actions */}
        <div className="flex items-center gap-2 shrink-0">
          {data.cancellation.scheduledAtPeriodEnd ? (
            <Button
              onClick={handleReactivateSubscription}
              disabled={isSubmittingAction}
              variant="outline"
              className="text-xs border-emerald-500/30 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-950/40"
            >
              {isSubmittingAction ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <RefreshCw className="w-3.5 h-3.5 mr-1.5 text-emerald-500" />}
              <span>Reactivate Subscription</span>
            </Button>
          ) : (
            <Button
              onClick={() => setIsCancelModalOpen(true)}
              variant="outline"
              className="text-xs text-slate-500 border-slate-200 dark:border-slate-800 hover:text-rose-600 dark:hover:text-rose-400"
            >
              <span>Cancel Subscription</span>
            </Button>
          )}

          <Button
            onClick={() => {
              setActiveTab('plans');
              setIsPlanModalOpen(true);
            }}
            variant="primary"
            className="text-xs flex items-center gap-1.5"
          >
            <Zap className="w-3.5 h-3.5 text-amber-300" />
            <span>Change Plan</span>
          </Button>
        </div>
      </div>

      {/* INTERNAL NAVIGATION TABS */}
      <div className="flex items-center gap-1.5 p-1 rounded-xl bg-slate-100 dark:bg-slate-950/80 border border-slate-200 dark:border-slate-800 text-xs overflow-x-auto max-w-full">
        <button
          onClick={() => setActiveTab('overview')}
          className={`px-4 py-2 rounded-lg font-semibold transition-all flex items-center gap-2 shrink-0 ${
            activeTab === 'overview'
              ? 'bg-blue-600 text-white shadow-md'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-slate-900'
          }`}
        >
          <Sparkles className="w-3.5 h-3.5" />
          <span>Overview</span>
        </button>

        <button
          onClick={() => setActiveTab('plans')}
          className={`px-4 py-2 rounded-lg font-semibold transition-all flex items-center gap-2 shrink-0 ${
            activeTab === 'plans'
              ? 'bg-blue-600 text-white shadow-md'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-slate-900'
          }`}
        >
          <Zap className="w-3.5 h-3.5 text-amber-400" />
          <span>Plan Comparison &amp; Preview</span>
        </button>

        <button
          onClick={() => setActiveTab('info')}
          className={`px-4 py-2 rounded-lg font-semibold transition-all flex items-center gap-2 shrink-0 ${
            activeTab === 'info'
              ? 'bg-blue-600 text-white shadow-md'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-slate-900'
          }`}
        >
          <Building className="w-3.5 h-3.5" />
          <span>Billing Information</span>
        </button>

        <button
          onClick={() => setActiveTab('payments')}
          className={`px-4 py-2 rounded-lg font-semibold transition-all flex items-center gap-2 shrink-0 ${
            activeTab === 'payments'
              ? 'bg-blue-600 text-white shadow-md'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-slate-900'
          }`}
        >
          <CreditCard className="w-3.5 h-3.5" />
          <span>Payment Methods</span>
        </button>

        <button
          onClick={() => setActiveTab('invoices')}
          className={`px-4 py-2 rounded-lg font-semibold transition-all flex items-center gap-2 shrink-0 ${
            activeTab === 'invoices'
              ? 'bg-blue-600 text-white shadow-md'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-slate-900'
          }`}
        >
          <Receipt className="w-3.5 h-3.5" />
          <span>Invoices &amp; Receipts</span>
        </button>
      </div>

      {/* TAB CONTENT 1: OVERVIEW */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          {/* SUBSCRIPTION INFORMATION CARD */}
          <Card className="relative overflow-hidden border-slate-200 dark:border-slate-800 bg-gradient-to-br from-white via-slate-50/50 to-blue-50/20 dark:from-slate-900 dark:via-slate-900/95 dark:to-blue-950/20">
            <CardHeader className="border-b-0 pb-2">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 w-full">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-blue-600/15 text-blue-600 dark:text-blue-400 flex items-center justify-center border border-blue-500/20 shadow-xs">
                    <Sparkles className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">
                        {plan.name}
                      </h2>
                      {isInternalNonBillable ? (
                        <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-purple-500/15 text-purple-700 dark:text-purple-300 border border-purple-500/30">
                          Internal / Non-billable
                        </span>
                      ) : (
                        <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30 capitalize">
                          {data.status}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      {plan.description || 'Current active subscription plan for this workspace.'}
                    </p>
                  </div>
                </div>

                {/* Change Plan Action */}
                <div className="flex items-center gap-2">
                  <button
                    disabled
                    title="Self-serve plan switching will be enabled when commercial public tiers launch."
                    className="px-3.5 py-2 rounded-xl text-xs font-semibold bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500 cursor-not-allowed flex items-center gap-1.5 border border-slate-200 dark:border-slate-700/60 opacity-80"
                  >
                    <Lock className="w-3.5 h-3.5" />
                    <span>Change Plan</span>
                    <span className="px-1.5 py-0.2 rounded-md bg-slate-200 dark:bg-slate-700 text-[10px] font-bold text-slate-600 dark:text-slate-300">
                      Upcoming
                    </span>
                  </button>
                </div>
              </div>
            </CardHeader>

            {/* Factual Cancellation Banner */}
            {cancellation.scheduledAtPeriodEnd && (
              <div className="mx-5 mb-4 p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-800 dark:text-amber-200 text-xs flex items-start gap-2.5">
                <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold">Cancellation Status:</span> Cancellation is currently requested for the end of the billing period ({formattedPeriodEnd || 'period end'}).
                </div>
              </div>
            )}

            {/* Subscription Key Metadata Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 p-5 pt-2">
              {/* Fact 1: Active Workspace Seats */}
              <div className="p-4 rounded-xl bg-white/70 dark:bg-slate-950/60 border border-slate-200/80 dark:border-slate-800/80">
                <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 mb-1">
                  <span className="font-medium flex items-center gap-1.5">
                    <Users className="w-3.5 h-3.5 text-blue-500" />
                    Active Members
                  </span>
                </div>
                <div className="text-xl font-bold text-slate-900 dark:text-slate-100 flex items-baseline gap-1">
                  <span>{seats.active}</span>
                  <span className="text-xs text-slate-500 dark:text-slate-400 font-normal">
                    / {seats.maximum !== null ? `${seats.maximum.toLocaleString()} max` : 'Unlimited'}
                  </span>
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                  Occupied team seats in workspace
                </p>
              </div>

              {/* Fact 2: Recurring Billing Cost */}
              <div className="p-4 rounded-xl bg-white/70 dark:bg-slate-950/60 border border-slate-200/80 dark:border-slate-800/80">
                <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 mb-1">
                  <span className="font-medium flex items-center gap-1.5">
                    <CreditCard className="w-3.5 h-3.5 text-emerald-500" />
                    Billing Interval &amp; Price
                  </span>
                </div>
                <div className="text-xl font-bold text-slate-900 dark:text-slate-100">
                  {isInternalNonBillable ? (
                    <span className="text-sm font-semibold text-purple-600 dark:text-purple-400">
                      Non-billable
                    </span>
                  ) : recurringCostPreview && recurringCostPreview.isCalculable ? (
                    <div className="flex items-baseline gap-1">
                      <span>
                        {formatMinorUnitsToCurrencyString(
                          recurringCostPreview.amountMinor,
                          recurringCostPreview.currency
                        )}
                      </span>
                      <span className="text-xs text-slate-500 font-normal capitalize">
                        / {price?.billingInterval || 'period'}
                      </span>
                    </div>
                  ) : (
                    <span className="text-sm font-semibold text-slate-600 dark:text-slate-400">
                      Custom Quote
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                  {isInternalNonBillable
                    ? 'Internal dev tier — no commercial price applies'
                    : price
                    ? `Priced tier (${price.pricingModel.replace('_', ' ')})`
                    : 'Custom commercial agreement'}
                </p>
              </div>

              {/* Fact 3: Period Boundary / Renewal Date */}
              <div className="p-4 rounded-xl bg-white/70 dark:bg-slate-950/60 border border-slate-200/80 dark:border-slate-800/80">
                <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 mb-1">
                  <span className="font-medium flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5 text-amber-500" />
                    Renewal / Period Boundary
                  </span>
                </div>
                <div className="text-xl font-bold text-slate-900 dark:text-slate-100">
                  {isInternalNonBillable ? (
                    <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                      No billing cycle applies
                    </span>
                  ) : formattedPeriodEnd ? (
                    <span className="text-base font-semibold">{formattedPeriodEnd}</span>
                  ) : (
                    <span className="text-sm font-semibold text-slate-500 dark:text-slate-400">
                      Non-expiring
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                  {isInternalNonBillable
                    ? 'Internal plan — unlimited duration'
                    : period.hasFutureBoundary
                    ? 'Current billing cycle cutoff date'
                    : 'No recurring renewal cycle applies'}
                </p>
              </div>
            </div>
          </Card>

          {/* TWO-COLUMN CONTENT GRID */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* LEFT COLUMN: TEAM SEATS & COST BREAKDOWN (2 cols) */}
            <div className="lg:col-span-2 space-y-6">
              {/* TEAM SEATS & MEMBERS SECTION */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2">
                      <Users className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                      <span>Team Seats &amp; Active Members</span>
                    </span>
                    <span className="text-xs font-mono font-bold text-slate-700 dark:text-slate-300">
                      {seats.active} / {seats.maximum !== null ? seats.maximum.toLocaleString() : '∞'} seats
                    </span>
                  </CardTitle>
                </CardHeader>

                <div className="space-y-4">
                  {/* Visual Seat Utilization Progress Bar */}
                  {seatPercentage !== null && (
                    <div className="space-y-1.5">
                      <div className="flex justify-between text-xs text-slate-500 dark:text-slate-400 font-medium">
                        <span>Workspace Seat Utilization</span>
                        <span className="font-mono">{seatPercentage}% used</span>
                      </div>
                      <div className="w-full h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                        <div
                          className="h-full bg-blue-600 dark:bg-blue-500 rounded-full transition-all duration-500"
                          style={{ width: `${Math.max(1, seatPercentage)}%` }}
                        />
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                    <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60">
                      <div className="text-slate-500 dark:text-slate-400">Active Members</div>
                      <div className="text-base font-bold text-slate-900 dark:text-slate-100 font-mono mt-0.5">
                        {seats.active} active
                      </div>
                    </div>

                    <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60">
                      <div className="text-slate-500 dark:text-slate-400">Maximum Member Limit</div>
                      <div className="text-base font-bold text-slate-900 dark:text-slate-100 font-mono mt-0.5">
                        {seats.maximum !== null ? seats.maximum.toLocaleString() : 'Unlimited'}
                      </div>
                    </div>
                  </div>

                  <div className="p-3 rounded-xl bg-blue-500/10 border border-blue-500/20 text-xs text-blue-900 dark:text-blue-200 flex items-start gap-2.5">
                    <Info className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
                    <div className="text-[11px] leading-relaxed">
                      <strong>Seat Accounting Rule:</strong> Active workspace accounts assigned an Owner, Admin, Manager, or Agent role count towards active seat usage. Pending email invitations do not count as active seats until accepted.
                    </div>
                  </div>
                </div>
              </Card>

              {/* SUBSCRIPTION COST BREAKDOWN */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <Receipt className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                    <span>Subscription Cost Breakdown</span>
                  </CardTitle>
                </CardHeader>
                <div className="space-y-3 text-xs">
                  {isInternalNonBillable ? (
                    <div className="p-4 rounded-xl bg-purple-500/10 border border-purple-500/20 text-purple-900 dark:text-purple-200 space-y-1">
                      <div className="font-bold text-xs flex items-center gap-1.5">
                        <CheckCircle2 className="w-4 h-4 text-purple-600 dark:text-purple-400" />
                        <span>Internal Non-Billable Plan</span>
                      </div>
                      <p className="text-[11px] text-purple-800 dark:text-purple-300">
                        This workspace is using an internal non-billable plan. No recurring commercial subscription fees or invoice charges apply.
                      </p>
                    </div>
                  ) : recurringCostPreview && recurringCostPreview.isCalculable ? (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/30">
                        <span>Base Subscription Charge</span>
                        <span className="font-bold font-mono">
                          {formatMinorUnitsToCurrencyString(recurringCostPreview.amountMinor, recurringCostPreview.currency)}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950/50 border border-slate-200 dark:border-slate-800 text-slate-500 text-xs">
                      Custom commercial pricing structure. Please consult your enterprise agreement for cost breakdowns.
                    </div>
                  )}
                </div>
              </Card>
            </div>

            {/* RIGHT COLUMN: RECURRING SETTINGS & FUTURE CONTROLS (1 col) */}
            <div className="space-y-6">
              {/* AUTO-RENEW & LIFECYCLE CONTROLS */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <Sliders className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                    <span>Auto-Renew &amp; Settings</span>
                  </CardTitle>
                </CardHeader>
                <div className="space-y-3 pt-2 text-xs">
                  <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60 flex items-center justify-between">
                    <div>
                      <div className="font-semibold text-slate-900 dark:text-slate-100">Auto-Renew</div>
                      <div className="text-[11px] text-slate-500">Automatic renewal status</div>
                    </div>
                    <span className="px-2 py-0.5 rounded-md bg-slate-200 dark:bg-slate-800 text-[10px] font-bold text-slate-600 dark:text-slate-400">
                      Upcoming
                    </span>
                  </div>

                  <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60 flex items-center justify-between">
                    <div>
                      <div className="font-semibold text-slate-900 dark:text-slate-100">Subscription Cancellation</div>
                      <div className="text-[11px] text-slate-500">Self-serve cancellation policy</div>
                    </div>
                    <span className="px-2 py-0.5 rounded-md bg-slate-200 dark:bg-slate-800 text-[10px] font-bold text-slate-600 dark:text-slate-400">
                      Upcoming
                    </span>
                  </div>
                </div>
              </Card>

              {/* TELECOM CREDIT & NUMBER SUBSCRIPTION SEPARATION NOTICE */}
              <Card className="border-blue-500/20 bg-blue-500/5">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-xs text-blue-900 dark:text-blue-200">
                    <Zap className="w-4 h-4 text-blue-500" />
                    <span>Billing Architecture Separation</span>
                  </CardTitle>
                </CardHeader>
                <div className="p-3 pt-0 text-[11px] text-slate-600 dark:text-slate-400 space-y-2">
                  <p>
                    <strong>Telecom Credit:</strong> Prepaid PSTN calling balance is managed separately under <span className="font-semibold text-blue-600 dark:text-blue-400">BILLING &gt; Credit</span>.
                  </p>
                  <p>
                    <strong>VoIP Numbers:</strong> Number inventory &amp; assignment is managed under <span className="font-semibold text-blue-600 dark:text-blue-400">VOIP NUMBERS &gt; My Numbers</span>.
                  </p>
                </div>
              </Card>
            </div>
          </div>
        </div>
      )}

      {/* TAB CONTENT 2: PLAN COMPARISON & PROVISIONAL CATALOG PREVIEW */}
      {activeTab === 'plans' && (
        <div className="space-y-6">
          {/* PROVISIONAL DEVELOPMENT NOTICE BANNER */}
          <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-900 dark:text-amber-200 text-xs space-y-1">
            <div className="flex items-center gap-2 font-bold text-sm">
              <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
              <span>Development Preview: Provisional Pricing &amp; Feature Limits</span>
            </div>
            <p className="text-[11px] leading-relaxed text-amber-800 dark:text-amber-300">
              The pricing targets displayed below (Starter $18 / Pro $32 / Business $40) are <strong>provisional development targets</strong>. Public commercial pricing has not been finalized or published. Live customer subscription charging remains inactive.
            </p>
          </div>

          {/* BILLING INTERVAL SELECTOR */}
          <div className="flex items-center justify-between p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
            <div>
              <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">Billing Interval Selection</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">Choose between monthly and annual subscription billing</p>
            </div>
            <div className="flex items-center gap-2 p-1 rounded-lg bg-slate-100 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-xs">
              <button
                onClick={() => setIsAnnualBilling(false)}
                className={`px-3 py-1.5 rounded-md font-semibold transition-all ${
                  !isAnnualBilling ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs' : 'text-slate-500'
                }`}
              >
                Monthly Billing
              </button>
              <button
                onClick={() => setIsAnnualBilling(true)}
                className={`px-3 py-1.5 rounded-md font-semibold transition-all ${
                  isAnnualBilling ? 'bg-amber-500 text-white shadow-xs' : 'text-slate-500'
                }`}
              >
                Annual Billing
              </button>
            </div>
          </div>

          {/* ANNUAL PRICING WARNING BANNER IF ANNUAL SELECTED */}
          {isAnnualBilling && (
            <div className="p-3.5 rounded-xl bg-blue-500/10 border border-blue-500/30 text-blue-900 dark:text-blue-200 text-xs flex items-center gap-2.5">
              <Info className="w-4 h-4 text-blue-500 shrink-0" />
              <span className="font-semibold">Annual pricing coming soon.</span> Annual pricing contracts have not been published. Monthly pricing targets apply.
            </div>
          )}

          {/* DOWNGRADE CHECK RESULT ALERT */}
          {downgradeCheckState && (
            <div className={`p-4 rounded-xl border text-xs ${
              downgradeCheckState.loading
                ? 'bg-slate-50 border-slate-200 text-slate-700 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-300'
                : downgradeCheckState.result?.allowed
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-900 dark:text-emerald-200'
                : 'bg-rose-500/10 border-rose-500/30 text-rose-900 dark:text-rose-200'
            }`}>
              {downgradeCheckState.loading ? (
                <div className="flex items-center gap-2">
                  <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />
                  <span>Evaluating downgrade eligibility against target plan limits...</span>
                </div>
              ) : downgradeCheckState.result?.allowed ? (
                <div className="flex items-start gap-2.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-bold text-sm">Downgrade Eligible!</span>
                    <p className="mt-0.5 text-[11px]">
                      Your workspace active user count ({downgradeCheckState.result.currentActiveUsers}/{downgradeCheckState.result.targetMaxUsers}) and active phone number count ({downgradeCheckState.result.currentActiveNumbers}/{downgradeCheckState.result.targetMaxNumbers}) comply with the {downgradeCheckState.targetPlanCode.toUpperCase()} plan limits.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-2.5">
                  <AlertTriangle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-bold text-sm">Downgrade Blocked Safety Guard</span>
                    <p className="mt-1 text-[11px] leading-relaxed">
                      {downgradeCheckState.result?.reason || 'Downgrade is restricted. Active usage exceeds target plan limits.'}
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* PLAN CARDS GRID */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* STARTER CARD */}
            <Card className="flex flex-col justify-between border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 relative">
              <div className="p-5 space-y-4">
                <div>
                  <div className="flex items-center justify-between">
                    <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">Starter</h3>
                    <Badge variant="neutral" className="text-[10px]">Provisional</Badge>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">For small teams getting started with VoIP calling &amp; SMS.</p>
                </div>

                <div className="py-2 border-y border-slate-100 dark:border-slate-800/60">
                  <div className="text-2xl font-bold text-slate-900 dark:text-slate-100 flex items-baseline gap-1">
                    <span>$18</span>
                    <span className="text-xs font-normal text-slate-500">/ user / mo</span>
                  </div>
                  <p className="text-[10px] text-slate-400 mt-0.5">Billed monthly per active user seat</p>
                </div>

                <div className="space-y-2 text-xs">
                  <div className="flex items-center justify-between font-semibold text-slate-700 dark:text-slate-300">
                    <span>Max Active Users</span>
                    <span className="font-mono text-blue-600 dark:text-blue-400">5 seats</span>
                  </div>
                  <div className="flex items-center justify-between font-semibold text-slate-700 dark:text-slate-300">
                    <span>Max Phone Numbers</span>
                    <span className="font-mono text-blue-600 dark:text-blue-400">1 line</span>
                  </div>
                  <div className="pt-2 border-t border-slate-100 dark:border-slate-800/60 space-y-1.5 text-[11px] text-slate-600 dark:text-slate-400">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                      <span>Voice Calling (Outbound / Inbound)</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                      <span>SMS &amp; MMS Messaging</span>
                    </div>
                    <div className="flex items-center gap-2 text-rose-600 dark:text-rose-400 font-medium">
                      <Lock className="w-3.5 h-3.5 shrink-0" />
                      <span>Call Recording (DISABLED on Starter)</span>
                    </div>
                    <div className="flex items-center gap-2 text-slate-400">
                      <Lock className="w-3.5 h-3.5 shrink-0" />
                      <span>Analytics &amp; CRM Integrations</span>
                    </div>
                    <div className="flex items-center gap-2 text-amber-500 font-medium">
                      <Clock className="w-3.5 h-3.5 shrink-0" />
                      <span>IVR &amp; Call Queues (In Development)</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="p-5 pt-0">
                <Button
                  onClick={() => handleCheckDowngrade('starter')}
                  variant="outline"
                  className="w-full text-xs"
                >
                  Check Starter Downgrade Safety
                </Button>
              </div>
            </Card>

            {/* PRO CARD */}
            <Card className="flex flex-col justify-between border-blue-500/30 dark:border-blue-500/30 bg-gradient-to-b from-blue-50/20 to-transparent dark:from-blue-950/20 dark:to-transparent relative shadow-sm">
              <div className="p-5 space-y-4">
                <div>
                  <div className="flex items-center justify-between">
                    <h3 className="text-base font-bold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
                      <span>Pro</span>
                      <Sparkles className="w-4 h-4 text-blue-500" />
                    </h3>
                    <Badge variant="blue" className="text-[10px]">Recommended</Badge>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">For growing teams requiring call recording &amp; analytics.</p>
                </div>

                <div className="py-2 border-y border-slate-100 dark:border-slate-800/60">
                  <div className="text-2xl font-bold text-slate-900 dark:text-slate-100 flex items-baseline gap-1">
                    <span>$32</span>
                    <span className="text-xs font-normal text-slate-500">/ user / mo</span>
                  </div>
                  <p className="text-[10px] text-slate-400 mt-0.5">Billed monthly per active user seat</p>
                </div>

                <div className="space-y-2 text-xs">
                  <div className="flex items-center justify-between font-semibold text-slate-700 dark:text-slate-300">
                    <span>Max Active Users</span>
                    <span className="font-mono text-blue-600 dark:text-blue-400">20 seats</span>
                  </div>
                  <div className="flex items-center justify-between font-semibold text-slate-700 dark:text-slate-300">
                    <span>Max Phone Numbers</span>
                    <span className="font-mono text-blue-600 dark:text-blue-400">3 lines</span>
                  </div>
                  <div className="pt-2 border-t border-slate-100 dark:border-slate-800/60 space-y-1.5 text-[11px] text-slate-600 dark:text-slate-400">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                      <span>Voice Calling &amp; Messaging</span>
                    </div>
                    <div className="flex items-center gap-2 font-medium text-emerald-600 dark:text-emerald-400">
                      <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                      <span>Call Recording (INCLUDED)</span>
                    </div>
                    <div className="flex items-center gap-2 font-medium text-emerald-600 dark:text-emerald-400">
                      <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                      <span>Analytics &amp; Reporting</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                      <span>CRM Integrations (General)</span>
                    </div>
                    <div className="flex items-center gap-2 text-amber-500 font-medium">
                      <Clock className="w-3.5 h-3.5 shrink-0" />
                      <span>IVR &amp; Call Queues (In Development)</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="p-5 pt-0">
                <Button
                  onClick={() => handleCheckDowngrade('pro')}
                  variant="outline"
                  className="w-full text-xs"
                >
                  Check Pro Downgrade Safety
                </Button>
              </div>
            </Card>

            {/* BUSINESS CARD */}
            <Card className="flex flex-col justify-between border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 relative">
              <div className="p-5 space-y-4">
                <div>
                  <div className="flex items-center justify-between">
                    <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">Business</h3>
                    <Badge variant="neutral" className="text-[10px]">Enterprise</Badge>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">For advanced organizations requiring Zoho CRM &amp; multi-line capacity.</p>
                </div>

                <div className="py-2 border-y border-slate-100 dark:border-slate-800/60">
                  <div className="text-2xl font-bold text-slate-900 dark:text-slate-100 flex items-baseline gap-1">
                    <span>$40</span>
                    <span className="text-xs font-normal text-slate-500">/ user / mo</span>
                  </div>
                  <p className="text-[10px] text-slate-400 mt-0.5">Billed monthly per active user seat</p>
                </div>

                <div className="space-y-2 text-xs">
                  <div className="flex items-center justify-between font-semibold text-slate-700 dark:text-slate-300">
                    <span>Max Active Users</span>
                    <span className="font-mono text-blue-600 dark:text-blue-400">50 seats</span>
                  </div>
                  <div className="flex items-center justify-between font-semibold text-slate-700 dark:text-slate-300">
                    <span>Max Phone Numbers</span>
                    <span className="font-mono text-blue-600 dark:text-blue-400">10 lines</span>
                  </div>
                  <div className="pt-2 border-t border-slate-100 dark:border-slate-800/60 space-y-1.5 text-[11px] text-slate-600 dark:text-slate-400">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                      <span>Voice Calling, SMS &amp; MMS</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                      <span>Call Recording &amp; Analytics</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                      <span>CRM Integrations &amp; Zoho CRM</span>
                    </div>
                    <div className="flex items-center gap-2 font-medium text-purple-600 dark:text-purple-400">
                      <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                      <span>Priority Support &amp; SLA</span>
                    </div>
                    <div className="flex items-center gap-2 text-amber-500 font-medium">
                      <Clock className="w-3.5 h-3.5 shrink-0" />
                      <span>IVR &amp; Call Queues (In Development)</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="p-5 pt-0">
                <Button
                  onClick={() => handleCheckDowngrade('business')}
                  variant="outline"
                  className="w-full text-xs"
                >
                  Check Business Downgrade Safety
                </Button>
              </div>
            </Card>
          </div>
        </div>
      )}

      {/* TAB CONTENT 3: BILLING INFORMATION */}
      {activeTab === 'info' && (
        <Card className="max-w-3xl">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Building className="w-4 h-4 text-purple-600 dark:text-purple-400" />
              <span>Billing Information &amp; Contact Details</span>
            </CardTitle>
          </CardHeader>
          <div className="space-y-4 text-xs">
            <p className="text-slate-500 dark:text-slate-400">
              The organization details below are used for official invoice headers and billing notices.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60">
                <div className="text-[11px] text-slate-500 dark:text-slate-400">Organization / Billing Name</div>
                <div className="text-sm font-semibold text-slate-900 dark:text-slate-100 mt-0.5">
                  {organization?.name || 'Workspace Account'}
                </div>
              </div>

              <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60">
                <div className="text-[11px] text-slate-500 dark:text-slate-400">Billing Contact Email</div>
                <div className="text-sm font-semibold text-slate-900 dark:text-slate-100 mt-0.5">
                  {profile?.email || 'N/A'}
                </div>
              </div>

              <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60 flex items-center justify-between">
                <div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">Billing Address</div>
                  <div className="text-xs font-medium text-slate-400 mt-0.5">Not configured</div>
                </div>
              </div>

              <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60 flex items-center justify-between">
                <div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">Country / Region</div>
                  <div className="text-xs font-medium text-slate-400 mt-0.5">Not configured</div>
                </div>
              </div>

              <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60 flex items-center justify-between sm:col-span-2">
                <div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">Tax Identification / GST / VAT Number</div>
                  <div className="text-xs font-medium text-slate-400 mt-0.5">Not configured</div>
                </div>
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* TAB CONTENT 3: PAYMENT METHODS */}
      {activeTab === 'payments' && (
        <div className="space-y-6 max-w-3xl">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between w-full">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <CreditCard className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                  <span>Workspace Payment Profile</span>
                </CardTitle>
                <Badge variant="blue" className="text-[10px]">
                  TEST MODE
                </Badge>
              </div>
            </CardHeader>
            <div className="p-4 pt-0 space-y-4">
              {paymentProfile?.hasDefaultPaymentMethod && paymentProfile.paymentMethod ? (
                <div className="space-y-4">
                  <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex items-center justify-between">
                    <div className="flex items-center gap-3.5">
                      <div className="w-11 h-11 rounded-xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 flex items-center justify-center font-bold text-xs uppercase shrink-0 border border-indigo-500/20">
                        {paymentProfile.paymentMethod.brand}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-bold text-slate-900 dark:text-slate-100 capitalize">
                            {paymentProfile.paymentMethod.brand}
                          </span>
                          <span className="px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[10px] font-extrabold tracking-wide">
                            DEFAULT
                          </span>
                        </div>
                        <div className="text-xs font-mono text-slate-600 dark:text-slate-400 mt-0.5">
                          •••• {paymentProfile.paymentMethod.last4}
                        </div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                          {paymentProfile.paymentMethod.expMonth && paymentProfile.paymentMethod.expYear
                            ? `Expires ${String(paymentProfile.paymentMethod.expMonth).padStart(2, '0')}/${String(paymentProfile.paymentMethod.expYear).slice(-2)}`
                            : 'Default workspace payment method'}
                        </div>
                      </div>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => setIsCardModalOpen(true)}>
                      Change Payment Method
                    </Button>
                  </div>

                  <div className="p-3.5 rounded-xl bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs space-y-1 text-slate-600 dark:text-slate-400">
                    <div className="font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
                      <Shield className="w-3.5 h-3.5 text-indigo-500" />
                      <span>Unified Workspace Payment Coverage</span>
                    </div>
                    <p className="text-[11px] leading-relaxed">
                      Used for your recurring VoIP Hub service charges (SaaS subscription &amp; active phone line rentals) and, when Auto Top-Up is enabled, telecom credit Auto Top-Up.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="py-8 text-center space-y-3">
                  <div className="w-12 h-12 mx-auto rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400">
                    <CreditCard className="w-6 h-6 text-slate-400" />
                  </div>
                  <div className="space-y-1">
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      No default payment method saved
                    </h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
                      Save a workspace payment card to authorize recurring service charges and enable telecom wallet Auto Top-Up.
                    </p>
                  </div>
                  <div className="pt-1">
                    <Button variant="primary" size="sm" onClick={() => setIsCardModalOpen(true)}>
                      <Plus className="w-4 h-4 mr-1.5" />
                      Add Workspace Card
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </Card>
        </div>
      )}

      {/* TAB CONTENT 4: INVOICES & RECEIPTS */}
      {activeTab === 'invoices' && (
        <Card className="max-w-3xl">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Receipt className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
              <span>Invoices &amp; Receipts</span>
            </CardTitle>
          </CardHeader>
          <div className="py-10 text-center space-y-3">
            <div className="w-12 h-12 mx-auto rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400">
              <Receipt className="w-6 h-6 text-slate-400" />
            </div>
            <div className="space-y-1">
              <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                No invoices or receipts available
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
                Authoritative payment receipts and PDF invoices will automatically appear here once commercial billing transactions occur.
              </p>
            </div>
          </div>
        </Card>
      )}

      {/* Workspace Payment Method Modal */}
      <WorkspacePaymentMethodModal
        isOpen={isCardModalOpen}
        onClose={() => setIsCardModalOpen(false)}
        onSuccess={() => {
          fetchPaymentProfile();
        }}
      />

      {/* Subscription Cancellation Modal */}
      {isCancelModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-xs">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl max-w-lg w-full p-6 space-y-5 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-rose-500/10 text-rose-600 dark:text-rose-400 flex items-center justify-center shrink-0 border border-rose-500/20">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">
                  Cancel Workspace Subscription?
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  Cancellation will schedule your SaaS subscription to end at the end of the current billing period.
                </p>
              </div>
            </div>

            <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950/50 border border-slate-200 dark:border-slate-800 text-xs space-y-2.5">
              <div className="font-semibold text-slate-900 dark:text-slate-100">
                What happens when you cancel:
              </div>
              <div className="space-y-2 text-[11px] text-slate-600 dark:text-slate-400">
                <div className="flex items-start gap-2">
                  <CheckCircle2 className="w-3.5 h-3.5 text-blue-500 shrink-0 mt-0.5" />
                  <span>SaaS functionality remains fully active through the end of your paid billing cycle.</span>
                </div>
                <div className="flex items-start gap-2">
                  <CheckCircle2 className="w-3.5 h-3.5 text-blue-500 shrink-0 mt-0.5" />
                  <span>Phone numbers are NOT released automatically. Numbers follow their own rental &amp; offboarding lifecycle.</span>
                </div>
                <div className="flex items-start gap-2">
                  <CheckCircle2 className="w-3.5 h-3.5 text-blue-500 shrink-0 mt-0.5" />
                  <span>Prepaid Telecom Credit wallet balance is preserved and remains intact.</span>
                </div>
                <div className="flex items-start gap-2">
                  <CheckCircle2 className="w-3.5 h-3.5 text-blue-500 shrink-0 mt-0.5" />
                  <span>Port-out management rights for active numbers remain fully accessible.</span>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2 border-t border-slate-100 dark:border-slate-800">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIsCancelModalOpen(false)}
                disabled={isSubmittingAction}
              >
                Keep Subscription
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={handleCancelSubscription}
                disabled={isSubmittingAction}
                className="bg-rose-600 hover:bg-rose-700 text-white"
              >
                {isSubmittingAction ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
                    Scheduling Cancellation...
                  </>
                ) : (
                  'Confirm Cancellation'
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

