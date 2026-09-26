import React from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Receipt, Hash, Phone, Lock, Info, CheckCircle2 } from 'lucide-react';

export default function BillingNumbersPage() {
  return (
    <div className="space-y-6 max-w-4xl mx-auto pb-12">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <Receipt className="w-5 h-5 text-indigo-500" />
            <span>Business Number Subscriptions</span>
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Recurring monthly subscription breakdown for workspace DID business phone numbers.
          </p>
        </div>
        <Badge variant="purple" size="md">
          RECURRING NUMBERS
        </Badge>
      </div>

      {/* Main Status Card */}
      <Card className="border-indigo-500/20 bg-indigo-500/5">
        <CardHeader className="pb-2 border-b-0">
          <div className="flex items-center justify-between w-full">
            <CardTitle className="text-base text-indigo-900 dark:text-indigo-200 flex items-center gap-2">
              <Hash className="w-4 h-4 text-indigo-500" />
              <span>Recurring Number Subscription Status</span>
            </CardTitle>
            <Badge variant="neutral" className="text-[10px]">
              Pending Setup
            </Badge>
          </div>
        </CardHeader>
        <div className="p-4 pt-0 space-y-4">
          <div className="text-lg font-bold text-slate-900 dark:text-slate-100">
            Number billing is not configured yet.
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400 max-w-2xl">
            Recurring monthly charges associated with provisioned business phone numbers will be itemized here when online number billing and self-serve number ordering are enabled for your workspace.
          </p>
          <div className="p-3 rounded-lg bg-slate-100 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-xs text-slate-500 flex items-start gap-2">
            <Info className="w-4 h-4 text-indigo-500 shrink-0 mt-0.5" />
            <span>
              This section is specifically for recurring phone number subscription fees. To manage your active phone numbers, caller assignments, and routing preferences, visit <strong>VoIP Numbers &gt; My Numbers</strong>.
            </span>
          </div>
        </div>
      </Card>
    </div>
  );
}
