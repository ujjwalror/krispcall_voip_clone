import React from 'react';
import { BillingSettings } from '@/components/settings/BillingSettings';
import { Settings, CreditCard } from 'lucide-react';

export default function SettingsBillingPage() {
  return (
    <div className="space-y-6 max-w-4xl mx-auto pb-12">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <CreditCard className="w-5 h-5 text-emerald-500 dark:text-emerald-400" />
            <span>Billing & Subscription</span>
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Manage your organization's subscription plan, active seat entitlements, recurring cost breakdown, and billing details.
          </p>
        </div>
      </div>

      <BillingSettings />
    </div>
  );
}
