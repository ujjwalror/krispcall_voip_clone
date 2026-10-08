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

  // Tab State: 'overview' | 'info' | 'payments' | 'invoices'
  const [activeTab, setActiveTab] = useState<'overview' | 'info' | 'payments' | 'invoices'>('overview');

  const fetchPaymentProfile = useCallback(async () => {
    try {
      const res = await fetch('/api/billing/workspace-payment-profile');
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
      const res = await fetch('/api/billing/subscription');
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

        {/* Change Plan Top Header Action */}
        <div className="flex items-center gap-2 shrink-0">
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

      {/* TAB CONTENT 2: BILLING INFORMATION */}
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
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-indigo-500/10 text-indigo-500 flex items-center justify-center font-bold text-xs uppercase">
                        {paymentProfile.paymentMethod.brand}
                      </div>
                      <div>
                        <div className="text-sm font-bold text-slate-900 dark:text-slate-100 capitalize">
                          {paymentProfile.paymentMethod.brand} ending in {paymentProfile.paymentMethod.last4}
                        </div>
                        <div className="text-xs text-slate-500">
                          Default workspace off-session payment method
                        </div>
                      </div>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => setIsCardModalOpen(true)}>
                      Change Card
                    </Button>
                  </div>

                  <div className="p-3.5 rounded-xl bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs space-y-1 text-slate-600 dark:text-slate-400">
                    <div className="font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
                      <Shield className="w-3.5 h-3.5 text-indigo-500" />
                      <span>Unified Workspace Payment Coverage</span>
                    </div>
                    <p className="text-[11px] leading-relaxed">
                      This payment method is used for your recurring VoIP Hub service charges (SaaS subscription &amp; active phone line rentals) and, if enabled, telecom credit Auto Top-Up.
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
    </div>
  );
}

