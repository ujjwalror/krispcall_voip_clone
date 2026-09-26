import React from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Zap, CreditCard, Lock, Bell, RefreshCw, Shield, AlertCircle, Info } from 'lucide-react';

export default function BillingCreditPage() {
  return (
    <div className="space-y-6 max-w-4xl mx-auto pb-12">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <Zap className="w-5 h-5 text-amber-500" />
            <span>Prepaid Telecom Credit & Auto-Recharge</span>
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
              <span>Telecom Usage Credit Balance</span>
            </CardTitle>
            <Badge variant="neutral" className="text-[10px]">
              Pending Setup
            </Badge>
          </div>
        </CardHeader>
        <div className="p-4 pt-0 space-y-4">
          <div className="text-lg font-bold text-slate-900 dark:text-slate-100">
            Credit balance not configured
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400 max-w-2xl">
            Prepaid calling credit for outbound PSTN calls and SMS usage operates independently from subscription plan fees. Balance recharge settings and per-minute PSTN rates will become configurable here.
          </p>
          <div className="flex items-center gap-3 pt-1">
            <button
              disabled
              className="px-4 py-2 rounded-xl text-xs font-semibold bg-amber-500/10 text-amber-700 dark:text-amber-300 cursor-not-allowed border border-amber-500/20 opacity-80 flex items-center gap-2"
            >
              <Lock className="w-3.5 h-3.5" />
              <span>Purchase Calling Credit</span>
              <span className="px-1.5 py-0.2 rounded-md bg-amber-200/50 dark:bg-amber-900/50 text-[10px]">
                Upcoming
              </span>
            </button>
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
              <span>Auto-Recharge Configuration</span>
            </CardTitle>
          </CardHeader>
          <div className="space-y-4 text-xs">
            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60">
              <div className="text-[11px] text-slate-500 dark:text-slate-400">Recharge Trigger Threshold</div>
              <div className="font-semibold text-slate-900 dark:text-slate-100 mt-0.5">
                Not configured
              </div>
            </div>

            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60">
              <div className="text-[11px] text-slate-500 dark:text-slate-400">Auto-Recharge Amount</div>
              <div className="font-semibold text-slate-900 dark:text-slate-100 mt-0.5">
                Not configured
              </div>
            </div>

            <div className="p-3 rounded-lg bg-slate-100 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-[11px] text-slate-500 flex items-start gap-2">
              <Info className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
              <span>
                Auto-recharge automatically replenishes calling credit when your balance drops below your chosen threshold.
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
              <div className="text-[11px] text-slate-500 dark:text-slate-400">Email Notification Threshold</div>
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
    </div>
  );
}
