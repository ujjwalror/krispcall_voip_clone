'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Zap, Lock, Bell, RefreshCw, Shield, Info, AlertTriangle, Loader2, History, ChevronLeft, ChevronRight, PlusCircle } from 'lucide-react';
import { formatMinorUnitsToCurrency } from '@/lib/billing/currencyFormatter';
import { AddCreditsModal } from '@/components/billing/AddCreditsModal';

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

export default function BillingCreditPage() {
  const [summaryLoading, setSummaryLoading] = useState<boolean>(true);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summary, setSummary] = useState<CreditSummaryData | null>(null);
  const [isAddCreditsOpen, setIsAddCreditsOpen] = useState<boolean>(false);

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

  return (
    <div className="space-y-6 max-w-4xl mx-auto pb-12">
      {/* Header */}
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

      {/* Credit Balance Card */}
      <Card className="border-amber-500/20 bg-amber-500/5">
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
            {(() => {
              const role = (summary?.role || '').toLowerCase();
              const isAllowed = ['owner', 'admin'].includes(role);

              if (summaryLoading) {
                return (
                  <button
                    disabled
                    className="px-4 py-2 rounded-xl text-xs font-semibold bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/20 opacity-70 flex items-center gap-2"
                  >
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-500" />
                    <span>Loading...</span>
                  </button>
                );
              }

              if (isAllowed) {
                return (
                  <button
                    onClick={() => setIsAddCreditsOpen(true)}
                    className="px-4 py-2 rounded-xl text-xs font-bold bg-amber-500 hover:bg-amber-400 text-slate-950 shadow-md shadow-amber-500/20 transition flex items-center gap-2"
                  >
                    <PlusCircle className="w-4 h-4" />
                    <span>Add Credits</span>
                  </button>
                );
              }

              return (
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
              );
            })()}
          </div>
        </div>
      </Card>

      {/* Grid for Auto-Recharge and Notifications */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Auto-Recharge Settings */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <RefreshCw className="w-4 h-4 text-blue-500" />
              <span>Auto-Top-Up Configuration</span>
            </CardTitle>
          </CardHeader>
          <div className="space-y-4 text-xs">
            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60">
              <div className="text-[11px] text-slate-500 dark:text-slate-400">Recharge Trigger Threshold</div>
              <div className="font-semibold text-slate-900 dark:text-slate-100 mt-0.5">
                Not configured (Disabled)
              </div>
            </div>

            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60">
              <div className="text-[11px] text-slate-500 dark:text-slate-400">Auto-Top-Up Amount</div>
              <div className="font-semibold text-slate-900 dark:text-slate-100 mt-0.5">
                Not configured
              </div>
            </div>

            <div className="p-3 rounded-lg bg-slate-100 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-[11px] text-slate-500 flex items-start gap-2">
              <Info className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
              <span>
                Auto-Top-Up automatically replenishes calling credits when your balance drops below your chosen threshold.
              </span>
            </div>
          </div>
        </Card>

        {/* Low Balance Alert Notifications */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Bell className="w-4 h-4 text-purple-500" />
              <span>Low Balance Alerts</span>
            </CardTitle>
          </CardHeader>
          <div className="space-y-4 text-xs">
            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60">
              <div className="text-[11px] text-slate-500 dark:text-slate-400">Notification Threshold</div>
              <div className="font-semibold text-slate-900 dark:text-slate-100 mt-0.5">
                Not configured
              </div>
            </div>

            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60">
              <div className="text-[11px] text-slate-500 dark:text-slate-400">Recipients</div>
              <div className="font-semibold text-slate-900 dark:text-slate-100 mt-0.5">
                Workspace Owners & Admins
              </div>
            </div>

            <div className="p-3 rounded-lg bg-slate-100 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-[11px] text-slate-500 flex items-start gap-2">
              <Shield className="w-4 h-4 text-purple-500 shrink-0 mt-0.5" />
              <span>
                Low balance alerts ensure outbound calling and SMS capabilities continue without disruption.
              </span>
            </div>
          </div>
        </Card>
      </div>

      {/* Transaction History Section */}
      <Card>
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
