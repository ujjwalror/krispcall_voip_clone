'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import {
  Zap,
  Lock,
  Bell,
  AlertTriangle,
  Loader2,
  History,
  ChevronLeft,
  ChevronRight,
  PlusCircle,
  Shield,
  Check,
} from 'lucide-react';
import { formatMinorUnitsToCurrency } from '@/lib/billing/currencyFormatter';
import { AddCreditsModal } from '@/components/billing/AddCreditsModal';
import { AutoTopupCard } from '@/components/billing/AutoTopupCard';

interface CreditSummaryData {
  success: boolean;
  availableCreditsMinor: number;
  formattedBalance: string;
  currency: string;
  role?: string;
}

interface TransactionItem {
  id: string;
  occurredAt: string;
  category: string;
  description: string;
  amountMinor: number;
  formattedAmount: string;
  balanceAfterMinor: number;
  formattedBalanceAfter: string;
  currency: string;
}

interface PaginationMeta {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

const PRESET_ALERT_THRESHOLDS = [5, 10, 20, 50];

export default function BillingCreditPage() {
  const [summaryLoading, setSummaryLoading] = useState<boolean>(true);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summary, setSummary] = useState<CreditSummaryData | null>(null);
  const [isAddCreditsOpen, setIsAddCreditsOpen] = useState<boolean>(false);

  // Low Balance Alerts state (independent from Auto Top-Up)
  const [alertsEnabled, setAlertsEnabled] = useState<boolean>(true);
  const [alertThresholdMajor, setAlertThresholdMajor] = useState<number>(10);
  const [alertsSaved, setAlertsSaved] = useState<boolean>(false);

  const [historyLoading, setHistoryLoading] = useState<boolean>(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [transactions, setTransactions] = useState<TransactionItem[]>([]);
  const [pagination, setPagination] = useState<PaginationMeta>({ total: 0, limit: 10, offset: 0, hasMore: false });

  // Fetch summary
  const fetchSummary = useCallback(async () => {
    try {
      setSummaryLoading(true);
      setSummaryError(null);
      const res = await fetch('/api/billing/credit/summary', {
        method: 'GET',
        headers: { 'Cache-Control': 'no-cache' },
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.message || 'Credits balance temporarily unavailable.');
      }

      const data: CreditSummaryData = await res.json();
      setSummary(data);
    } catch (err: any) {
      console.error('[BillingCreditPage] Error loading credit summary:', err.message || err);
      setSummaryError('Credits balance temporarily unavailable.');
    } finally {
      setSummaryLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary]);

  // Fetch transaction history
  const fetchHistory = async (offset: number = 0) => {
    try {
      setHistoryLoading(true);
      setHistoryError(null);
      const res = await fetch(`/api/billing/credit/history?limit=10&offset=${offset}`, {
        method: 'GET',
        headers: { 'Cache-Control': 'no-cache' },
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.message || 'Transaction history is temporarily unavailable.');
      }

      const data = await res.json();
      setTransactions(data.transactions || []);
      setPagination(data.pagination || { total: 0, limit: 10, offset: 0, hasMore: false });
    } catch (err: any) {
      console.error('[BillingCreditPage] Error loading transaction history:', err.message || err);
      setHistoryError('Transaction history is temporarily unavailable.');
    } finally {
      setHistoryLoading(false);
    }
  };

  useEffect(() => {
    fetchHistory(0);
  }, []);

  const displayBalance = summary
    ? summary.formattedBalance || formatMinorUnitsToCurrency(summary.availableCreditsMinor, summary.currency)
    : '$0.00 USD';

  const formatDate = (isoString: string) => {
    try {
      return new Date(isoString).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
    } catch {
      return isoString;
    }
  };

  const userRole = (summary?.role || '').toLowerCase();
  const canManage = ['owner', 'admin'].includes(userRole);

  return (
    <div className="space-y-6 max-w-4xl mx-auto pb-12">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <Zap className="w-5 h-5 text-amber-500" />
            <span>Prepaid Telecom Credits</span>
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Manage prepaid calling balance, PSTN call/SMS rates, low-balance alerts, and auto-recharge triggers.
          </p>
        </div>
        <Badge variant="amber" size="md">
          PREPAID USAGE
        </Badge>
      </div>

      {/* 1. Available Credit Card (Top) */}
      <Card className="border-amber-500/20 bg-amber-500/5 w-full">
        <CardHeader className="pb-2 border-b-0">
          <div className="flex items-center justify-between w-full">
            <CardTitle className="text-base text-amber-900 dark:text-amber-200 flex items-center gap-2">
              <Zap className="w-4 h-4 text-amber-500" />
              <span>Available Credits</span>
            </CardTitle>
            <Badge variant="neutral" className="text-[10px]">
              Prepaid Wallet
            </Badge>
          </div>
        </CardHeader>
        <div className="p-4 pt-0 space-y-4">
          {summaryLoading ? (
            <div className="flex items-center gap-2 text-slate-500 py-2">
              <Loader2 className="w-4 h-4 animate-spin text-amber-500" />
              <span className="text-xs">Loading available balance...</span>
            </div>
          ) : summaryError ? (
            <div className="flex items-center gap-2 text-amber-800 dark:text-amber-200 py-2 text-xs">
              <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
              <span>{summaryError}</span>
            </div>
          ) : (
            <div className="text-2xl font-extrabold text-slate-900 dark:text-slate-100 tracking-tight">
              {displayBalance}
            </div>
          )}

          <p className="text-xs text-slate-600 dark:text-slate-400 max-w-2xl">
            Prepaid calling credits operate independently from subscription plan fees and are used for outbound PSTN calls, incoming calls, and SMS usage.
          </p>

          <div className="flex items-center gap-3 pt-1">
            {summaryLoading ? (
              <button
                disabled
                className="px-4 py-2 rounded-xl text-xs font-semibold bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/20 opacity-70 flex items-center gap-2"
              >
                <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-500" />
                <span>Loading...</span>
              </button>
            ) : canManage ? (
              <button
                onClick={() => setIsAddCreditsOpen(true)}
                className="px-4 py-2 rounded-xl text-xs font-bold bg-amber-500 hover:bg-amber-400 text-slate-950 shadow-md shadow-amber-500/20 transition flex items-center gap-2"
              >
                <PlusCircle className="w-4 h-4" />
                <span>Add Credits</span>
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  disabled
                  className="px-4 py-2 rounded-xl text-xs font-semibold bg-slate-200 dark:bg-slate-800 text-slate-500 dark:text-slate-400 cursor-not-allowed border border-slate-300 dark:border-slate-700 opacity-80 flex items-center gap-2"
                >
                  <Lock className="w-3.5 h-3.5" />
                  <span>Add Credits</span>
                </button>
                <span className="text-[11px] text-slate-500 dark:text-slate-400 italic">
                  Only workspace Owners and Admins can add calling credits.
                </span>
              </div>
            )}
          </div>
        </div>
      </Card>

      {/* 2. Prominent FULL-WIDTH Auto Top-Up Section */}
      <AutoTopupCard
        userRole={summary?.role || 'agent'}
        onStatusChanged={fetchSummary}
      />

      {/* 3. Secondary FULL-WIDTH Low Balance Alerts Section */}
      <Card className="w-full border-slate-200 dark:border-slate-800">
        <CardHeader className="pb-3 border-b border-slate-100 dark:border-slate-800/60 flex flex-row items-center justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2.5">
              <Bell className="w-5 h-5 text-purple-500" />
              <CardTitle className="text-base font-bold text-slate-900 dark:text-slate-100">
                Low Balance Alerts
              </CardTitle>
              <Badge variant={alertsEnabled ? 'purple' : 'neutral'} className="text-[10px]">
                {alertsEnabled ? 'ACTIVE' : 'DISABLED'}
              </Badge>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Notify workspace owners and admins via email when available telecom credit falls below a set threshold.
            </p>
          </div>

          {/* Alerts ON / OFF Switch */}
          {canManage && (
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-xs font-semibold text-slate-600 dark:text-slate-400">
                {alertsEnabled ? 'ON' : 'OFF'}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={alertsEnabled}
                onClick={() => {
                  setAlertsEnabled(!alertsEnabled);
                  setAlertsSaved(true);
                  setTimeout(() => setAlertsSaved(false), 2500);
                }}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2 ${
                  alertsEnabled ? 'bg-purple-600' : 'bg-slate-300 dark:bg-slate-700'
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                    alertsEnabled ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
          )}
        </CardHeader>

        <div className="p-5 space-y-4 text-xs">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="font-semibold text-slate-700 dark:text-slate-300 block">
                Alert me when balance is less than or equal to
              </label>
              <select
                disabled={!alertsEnabled || !canManage}
                value={alertThresholdMajor}
                onChange={(e) => {
                  setAlertThresholdMajor(Number(e.target.value));
                  setAlertsSaved(true);
                  setTimeout(() => setAlertsSaved(false), 2500);
                }}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 font-medium focus:ring-2 focus:ring-purple-500 disabled:opacity-50"
              >
                {PRESET_ALERT_THRESHOLDS.map((amt) => (
                  <option key={amt} value={amt}>
                    ${amt}.00 USD
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="font-semibold text-slate-700 dark:text-slate-300 block">
                Notification Recipients
              </label>
              <div className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-slate-100 font-medium">
                Workspace Owners &amp; Admins
              </div>
            </div>
          </div>

          <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 text-[11px] text-slate-500 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Shield className="w-4 h-4 text-purple-500 shrink-0" />
              <span>Low balance alerts operate independently from Auto Top-Up and never initiate payments automatically.</span>
            </div>
            {alertsSaved && (
              <span className="text-purple-600 dark:text-purple-400 font-semibold flex items-center gap-1 shrink-0">
                <Check className="w-3.5 h-3.5" />
                <span>Saved</span>
              </span>
            )}
          </div>
        </div>
      </Card>

      {/* 4. Transaction History Section */}
      <Card className="w-full">
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <History className="w-4 h-4 text-amber-500" />
            <span>Transaction History</span>
          </CardTitle>
          {pagination.total > 0 && (
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Showing {pagination.offset + 1}-{Math.min(pagination.offset + pagination.limit, pagination.total)} of {pagination.total}
            </span>
          )}
        </CardHeader>

        <div className="p-4 pt-0">
          {historyLoading ? (
            <div className="flex items-center gap-2 text-slate-500 py-6 justify-center">
              <Loader2 className="w-4 h-4 animate-spin text-amber-500" />
              <span className="text-xs">Loading transaction history...</span>
            </div>
          ) : historyError ? (
            <div className="flex items-center gap-2 text-slate-600 dark:text-slate-400 py-6 justify-center text-xs">
              <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
              <span>{historyError}</span>
            </div>
          ) : transactions.length === 0 ? (
            <div className="text-center py-8 text-xs text-slate-500 dark:text-slate-400 border border-dashed border-slate-200 dark:border-slate-800 rounded-lg">
              No Credits transactions yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 font-medium">
                    <th className="pb-2.5 font-medium">Date</th>
                    <th className="pb-2.5 font-medium">Category</th>
                    <th className="pb-2.5 font-medium">Description</th>
                    <th className="pb-2.5 font-medium text-right">Amount</th>
                    <th className="pb-2.5 font-medium text-right">Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                  {transactions.map((tx) => (
                    <tr key={tx.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-900/30 transition-colors">
                      <td className="py-3 text-slate-600 dark:text-slate-300 whitespace-nowrap">
                        {formatDate(tx.occurredAt)}
                      </td>
                      <td className="py-3 whitespace-nowrap">
                        <Badge
                          variant={tx.amountMinor > 0 ? 'emerald' : 'neutral'}
                          className="text-[10px] capitalize font-semibold"
                        >
                          {tx.category}
                        </Badge>
                      </td>
                      <td className="py-3 text-slate-800 dark:text-slate-200 max-w-xs truncate">
                        {tx.description}
                      </td>
                      <td className={`py-3 text-right font-semibold whitespace-nowrap ${tx.amountMinor > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-900 dark:text-slate-100'}`}>
                        {tx.formattedAmount}
                      </td>
                      <td className="py-3 text-right text-slate-600 dark:text-slate-400 font-mono whitespace-nowrap">
                        {tx.formattedBalanceAfter}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Pagination Controls */}
              <div className="flex items-center justify-between pt-4 border-t border-slate-100 dark:border-slate-800/60">
                <button
                  disabled={pagination.offset === 0}
                  onClick={() => fetchHistory(Math.max(0, pagination.offset - pagination.limit))}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-200 dark:border-slate-800 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1 hover:bg-slate-50 dark:hover:bg-slate-900"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                  <span>Previous</span>
                </button>
                <button
                  disabled={!pagination.hasMore}
                  onClick={() => fetchHistory(pagination.offset + pagination.limit)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-200 dark:border-slate-800 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1 hover:bg-slate-50 dark:hover:bg-slate-900"
                >
                  <span>Next</span>
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* Add Credits Modal */}
      <AddCreditsModal
        isOpen={isAddCreditsOpen}
        onClose={() => setIsAddCreditsOpen(false)}
        currency={summary?.currency || 'USD'}
        prePaymentBalanceMinor={summary?.availableCreditsMinor || 0}
        onPaymentSuccess={() => {
          fetchSummary();
          fetchHistory(0);
        }}
      />
    </div>
  );
}
