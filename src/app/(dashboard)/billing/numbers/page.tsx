'use client';

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import {
  Receipt,
  Hash,
  Phone,
  Info,
  AlertTriangle,
  Loader2,
  RefreshCw,
  Settings,
  PlusCircle,
  Clock,
  Layers,
} from 'lucide-react';
import type {
  CustomerNumberSubscriptionDTO,
  OrganizationNumberSubscriptionsSummaryDTO,
} from '@/lib/telephony/marketplace/numberSubscriptionService';

export default function BillingNumbersPage() {
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<OrganizationNumberSubscriptionsSummaryDTO | null>(null);

  const fetchSubscriptions = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch('/api/billing/numbers', {
        method: 'GET',
        headers: { 'Cache-Control': 'no-cache' },
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.message || 'Number subscriptions temporarily unavailable.');
      }

      const data: OrganizationNumberSubscriptionsSummaryDTO = await res.json();
      setSummary(data);
    } catch (err: any) {
      console.error('[BillingNumbersPage] Error loading subscriptions:', err.message || err);
      setError('Number subscriptions temporarily unavailable.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSubscriptions();
  }, [fetchSubscriptions]);

  // Group active vs historical numbers
  const activeNumbers = useMemo(() => {
    return (summary?.numbers || []).filter((n) => n.numberStatus === 'active');
  }, [summary]);

  const historicalNumbers = useMemo(() => {
    return (summary?.numbers || []).filter((n) => n.numberStatus !== 'active');
  }, [summary]);

  const formatDate = (isoString: string) => {
    try {
      return new Date(isoString).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
    } catch {
      return isoString;
    }
  };

  const getStatusBadge = (status: CustomerNumberSubscriptionDTO['numberStatus']) => {
    switch (status) {
      case 'active':
        return <Badge variant="emerald">Active</Badge>;
      case 'inactive':
        return <Badge variant="neutral">Inactive</Badge>;
      case 'suspended':
        return <Badge variant="amber">Suspended</Badge>;
      case 'released':
        return <Badge variant="rose">Released</Badge>;
      case 'ported_out':
        return <Badge variant="purple">Ported Out</Badge>;
      default:
        return <Badge variant="neutral">{status}</Badge>;
    }
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto pb-12">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <Receipt className="w-5 h-5 text-indigo-500" />
            <span>Business Number Subscriptions</span>
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Contracted monthly rental obligations for workspace business phone numbers.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/numbers">
            <Button variant="outline" size="sm">
              <Settings className="w-3.5 h-3.5 mr-1 text-slate-500" />
              <span>Manage Numbers</span>
            </Button>
          </Link>
          <Badge variant="purple" size="md">
            RECURRING RENTALS
          </Badge>
        </div>
      </div>

      {/* Loading Skeleton */}
      {loading ? (
        <Card className="p-8 text-center border-indigo-500/20 bg-indigo-500/5">
          <div className="flex flex-col items-center justify-center gap-3 py-6">
            <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
            <div className="text-sm font-semibold text-slate-700 dark:text-slate-300">
              Loading number subscriptions...
            </div>
            <p className="text-xs text-slate-500 max-w-sm">
              Retrieving contracted phone numbers and active monthly rental details.
            </p>
          </div>
        </Card>
      ) : error ? (
        /* Error Banner */
        <Card className="border-rose-500/20 bg-rose-500/5 p-6">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-rose-500 shrink-0 mt-0.5" />
            <div className="space-y-2 flex-1">
              <div className="text-sm font-bold text-slate-900 dark:text-slate-100">
                {error}
              </div>
              <p className="text-xs text-slate-600 dark:text-slate-400">
                Failed to load authoritative billable resources for this workspace. Please try refreshing.
              </p>
              <Button onClick={fetchSubscriptions} variant="outline" size="sm" className="mt-2">
                <RefreshCw className="w-3.5 h-3.5 mr-1" />
                Retry Loading
              </Button>
            </div>
          </div>
        </Card>
      ) : (
        <>
          {/* Executive Summary Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Active Numbers Card */}
            <Card className="border-indigo-500/20 bg-indigo-500/5">
              <CardHeader className="pb-1 border-b-0">
                <div className="flex items-center justify-between w-full">
                  <CardTitle className="text-xs font-semibold text-indigo-900 dark:text-indigo-200 flex items-center gap-2 uppercase tracking-wider">
                    <Phone className="w-4 h-4 text-indigo-500" />
                    <span>Active Numbers</span>
                  </CardTitle>
                  <Badge variant="blue" className="text-[10px]">
                    Provisioned DID
                  </Badge>
                </div>
              </CardHeader>
              <div className="p-4 pt-1 space-y-1">
                <div className="text-3xl font-extrabold text-slate-900 dark:text-slate-100 tracking-tight">
                  {summary?.totalActiveNumbers || 0}
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Total active phone lines currently assigned to workspace.
                </p>
              </div>
            </Card>

            {/* Total Monthly Rental Card */}
            <Card className="border-emerald-500/20 bg-emerald-500/5">
              <CardHeader className="pb-1 border-b-0">
                <div className="flex items-center justify-between w-full">
                  <CardTitle className="text-xs font-semibold text-emerald-900 dark:text-emerald-200 flex items-center gap-2 uppercase tracking-wider">
                    <Receipt className="w-4 h-4 text-emerald-500" />
                    <span>
                      {summary?.hasUnpricedSubscriptions ? 'Known Monthly Rental' : 'Monthly Number Rental'}
                    </span>
                  </CardTitle>
                  <Badge
                    variant={summary?.hasUnpricedSubscriptions ? 'amber' : 'emerald'}
                    className="text-[10px]"
                  >
                    {summary?.hasUnpricedSubscriptions ? 'Partial Breakdown' : 'Contracted Retail'}
                  </Badge>
                </div>
              </CardHeader>
              <div className="p-4 pt-1 space-y-1">
                <div className="text-3xl font-extrabold text-slate-900 dark:text-slate-100 tracking-tight">
                  {summary?.formattedTotalMonthlyRetail || '$0.00 / month'}
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {summary?.hasUnpricedSubscriptions
                    ? `Known recurring rental for configured lines. (${summary.unpricedCount} ${summary.unpricedCount === 1 ? 'line' : 'lines'} pending setup).`
                    : summary?.hasMultipleCurrencies
                    ? 'Breakdown of active monthly rental obligations by currency.'
                    : 'Total recurring monthly retail rental obligation for active numbers.'}
                </p>
              </div>
            </Card>
          </div>

          {/* Empty State */}
          {summary?.numbers.length === 0 ? (
            <Card className="p-8 text-center border-dashed border-slate-300 dark:border-slate-800">
              <div className="flex flex-col items-center justify-center space-y-3 py-6 max-w-md mx-auto">
                <div className="w-12 h-12 rounded-full bg-slate-100 dark:bg-slate-800/80 flex items-center justify-center text-slate-500 dark:text-slate-400">
                  <Hash className="w-6 h-6 text-indigo-500" />
                </div>
                <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">
                  No active number subscriptions
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Your workspace does not have any active business phone numbers provisioned. Order a new number from the marketplace to get started.
                </p>
                <div className="pt-2">
                  <Link href="/numbers/marketplace">
                    <Button variant="primary" size="md">
                      <PlusCircle className="w-4 h-4 mr-1.5" />
                      Browse Number Marketplace
                    </Button>
                  </Link>
                </div>
              </div>
            </Card>
          ) : (
            /* Active Subscriptions List */
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Hash className="w-4 h-4 text-indigo-500" />
                  <span>Active Phone Number Subscriptions</span>
                </CardTitle>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {activeNumbers.length} active {activeNumbers.length === 1 ? 'subscription' : 'subscriptions'}
                </span>
              </CardHeader>

              <div className="p-4 pt-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 font-medium">
                        <th className="pb-2.5 font-medium">Phone Number</th>
                        <th className="pb-2.5 font-medium">Country / Type</th>
                        <th className="pb-2.5 font-medium">Capabilities</th>
                        <th className="pb-2.5 font-medium">Status</th>
                        <th className="pb-2.5 font-medium text-right">Monthly Retail</th>
                        <th className="pb-2.5 font-medium text-right">Activation Date</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                      {activeNumbers.map((num) => (
                        <tr key={num.numberId} className="hover:bg-slate-50/50 dark:hover:bg-slate-900/30 transition-colors">
                          <td className="py-3.5 text-slate-900 dark:text-slate-100 font-mono font-semibold whitespace-nowrap">
                            <div>{num.phoneNumber}</div>
                            {num.friendlyName && (
                              <div className="text-[11px] font-sans font-normal text-slate-500 dark:text-slate-400 mt-0.5">
                                {num.friendlyName}
                              </div>
                            )}
                          </td>
                          <td className="py-3.5 whitespace-nowrap">
                            <div className="flex items-center gap-1.5">
                              <Badge variant="blue" className="text-[10px]">
                                {num.countryCode}
                              </Badge>
                              <Badge variant="neutral" className="text-[10px] capitalize">
                                {num.numberType.replace('_', ' ')}
                              </Badge>
                            </div>
                          </td>
                          <td className="py-3.5 whitespace-nowrap">
                            <div className="flex items-center gap-1">
                              {num.capabilities.voice && (
                                <Badge variant="emerald" className="text-[9px]">Voice</Badge>
                              )}
                              {num.capabilities.sms && (
                                <Badge variant="blue" className="text-[9px]">SMS</Badge>
                              )}
                              {num.capabilities.mms && (
                                <Badge variant="purple" className="text-[9px]">MMS</Badge>
                              )}
                            </div>
                          </td>
                          <td className="py-3.5 whitespace-nowrap">
                            <div className="flex items-center gap-1.5">
                              {getStatusBadge(num.numberStatus)}
                              {num.billingStatus === 'pending_reconciliation' && (
                                <Badge variant="amber" className="text-[9px] flex items-center gap-1">
                                  <Clock className="w-2.5 h-2.5" />
                                  <span>Pending Setup</span>
                                </Badge>
                              )}
                            </div>
                          </td>
                          <td className="py-3.5 text-right font-semibold text-slate-900 dark:text-slate-100 whitespace-nowrap">
                            {num.monthlyRetailFormatted ? (
                              `${num.monthlyRetailFormatted} / mo`
                            ) : (
                              <span className="text-amber-600 dark:text-amber-400 font-normal italic text-[11px]">
                                Billing setup pending
                              </span>
                            )}
                          </td>
                          <td className="py-3.5 text-right text-slate-500 dark:text-slate-400 whitespace-nowrap">
                            {formatDate(num.purchasedAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Informational Footer Note */}
                <div className="mt-4 p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200/60 dark:border-slate-800/60 text-xs text-slate-500 flex items-start gap-2">
                  <Info className="w-4 h-4 text-indigo-500 shrink-0 mt-0.5" />
                  <span>
                    Monthly rental charges are billed according to your workspace contract. To configure inbound call routing, IVR menus, or assign numbers to team members, visit{' '}
                    <Link href="/numbers" className="text-indigo-600 dark:text-indigo-400 font-medium underline hover:text-indigo-500">
                      My Numbers
                    </Link>.
                  </span>
                </div>
              </div>
            </Card>
          )}

          {/* Historical / Inactive Numbers Section */}
          {historicalNumbers.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2 text-slate-700 dark:text-slate-300">
                  <Layers className="w-4 h-4 text-slate-400" />
                  <span>Historical &amp; Released Numbers</span>
                </CardTitle>
              </CardHeader>
              <div className="p-4 pt-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs opacity-75">
                    <thead>
                      <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 font-medium">
                        <th className="pb-2.5 font-medium">Phone Number</th>
                        <th className="pb-2.5 font-medium">Country / Type</th>
                        <th className="pb-2.5 font-medium">Status</th>
                        <th className="pb-2.5 font-medium text-right">Released Date</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                      {historicalNumbers.map((num) => (
                        <tr key={num.numberId}>
                          <td className="py-2.5 text-slate-700 dark:text-slate-300 font-mono">
                            {num.phoneNumber}
                          </td>
                          <td className="py-2.5">
                            <span className="text-[11px] text-slate-500 uppercase">
                              {num.countryCode} • {num.numberType.replace('_', ' ')}
                            </span>
                          </td>
                          <td className="py-2.5">
                            {getStatusBadge(num.numberStatus)}
                          </td>
                          <td className="py-2.5 text-right text-slate-500">
                            {formatDate(num.purchasedAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
