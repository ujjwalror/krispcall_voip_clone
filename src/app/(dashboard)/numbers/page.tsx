'use client';

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import {
  Hash,
  Phone,
  Plus,
  ArrowUpRight,
  Loader2,
  AlertTriangle,
  RefreshCw,
  Search,
  ChevronRight,
  Copy,
  Check,
  XCircle,
  Info,
  FileText,
} from 'lucide-react';
import { useAuth } from '@/components/providers/AuthProvider';

export interface PhoneNumberItem {
  id: string;
  organization_id: string;
  phone_number: string;
  friendly_name: string | null;
  active: boolean;
  is_primary: boolean;
  status?: 'active' | 'inactive' | 'suspended' | 'released' | 'ported_out';
  country_code?: string | null;
  number_type?: 'local' | 'mobile' | 'toll_free' | null;
  acquisition_source?: 'provider_purchase' | 'port_in' | 'legacy' | null;
  capabilities_voice?: boolean;
  capabilities_sms?: boolean;
  capabilities_mms?: boolean;
  inbound_routing_type?: string | null;
  inbound_routing_destination_id?: string | null;
  created_at: string;
}

export default function MyNumbersPage() {
  const router = useRouter();
  const { profile, organization } = useAuth();
  const [numbers, setNumbers] = useState<PhoneNumberItem[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Port In Explanatory Modal State
  const [isPortInModalOpen, setIsPortInModalOpen] = useState<boolean>(false);

  const fetchNumbers = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/phone-numbers');
      if (res.ok) {
        const json = await res.json();
        setNumbers(json.phoneNumbers || []);
      } else {
        const errJson = await res.json().catch(() => ({}));
        setError(errJson.error || 'Failed to load business phone numbers.');
      }
    } catch (err) {
      console.error('[MyNumbersPage] Error fetching numbers:', err);
      setError('Network error loading phone numbers. Please try again.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchNumbers();
  }, [fetchNumbers]);

  // Search filtering strictly on friendly_name and phone_number
  const filteredNumbers = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return numbers;
    return numbers.filter((num) => {
      const friendlyName = (num.friendly_name || '').toLowerCase();
      const phoneNumber = (num.phone_number || '').toLowerCase();
      return friendlyName.includes(q) || phoneNumber.includes(q);
    });
  }, [numbers, searchQuery]);

  // Derived status grouping based truthfully on DB `active` boolean
  const activeNumbers = useMemo(
    () => filteredNumbers.filter((n) => n.active === true),
    [filteredNumbers]
  );
  const inactiveNumbers = useMemo(
    () => filteredNumbers.filter((n) => n.active !== true),
    [filteredNumbers]
  );

  return (
    <div className="space-y-6 max-w-5xl mx-auto pb-12">
      {/* Header & Primary Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <Hash className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            <span>My Numbers</span>
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Manage the business phone numbers assigned to your workspace.
          </p>
        </div>

        {/* HEADER ACTIONS: Port In Existing Number & Buy New Number */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setIsPortInModalOpen(true)}
            className="px-3.5 py-2 rounded-xl text-xs font-semibold bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-1.5 border border-slate-200 dark:border-slate-800 shadow-sm transition-all"
          >
            <ArrowUpRight className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
            <span>Port In Existing Number</span>
          </button>

          <Link
            href="/numbers/marketplace"
            className="px-3.5 py-2 rounded-xl text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white flex items-center gap-1.5 shadow-sm transition-all"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Buy New Number</span>
          </Link>
        </div>
      </div>

      {/* PORT IN EXPLANATORY MODAL */}
      {isPortInModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl max-w-lg w-full p-6 space-y-4 shadow-xl animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2">
                <ArrowUpRight className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">
                  Port In Existing Number
                </h3>
              </div>
              <button
                onClick={() => setIsPortInModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1"
              >
                <XCircle className="w-5 h-5" />
              </button>
            </div>

            <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
              Transfer your existing business telephone numbers from your current carrier into VoIP Hub without losing customer calls.
            </p>

            <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-2 text-xs">
              <span className="font-bold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
                <FileText className="w-4 h-4 text-blue-500" />
                <span>Porting Process Requirements</span>
              </span>
              <ul className="list-disc list-inside space-y-1 text-slate-600 dark:text-slate-300 font-mono text-[11px]">
                <li>Letter of Authorization (LOA) signed by authorized account owner</li>
                <li>Recent copy of carrier billing statement (within 30 days)</li>
                <li>Account Number and Porting PIN/Passcode from existing provider</li>
                <li>Estimated transfer time: 5–10 business days</li>
              </ul>
            </div>

            <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/60 text-amber-800 dark:text-amber-300 text-xs flex items-start gap-2">
              <Info className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <span className="font-bold block">Foundation Readiness Notice</span>
                <span>
                  Port-In submission foundation is configured. Backend carrier provider submission is currently <strong>NOT_READY</strong> in this phase. Submitting an inquiry creates 0 provider mutations.
                </span>
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <Button
                onClick={() => setIsPortInModalOpen(false)}
                className="text-xs bg-blue-600 hover:bg-blue-700 text-white font-semibold px-4"
              >
                Got It
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      {isLoading ? (
        <div className="flex flex-col items-center justify-center py-16 space-y-4">
          <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
          <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">
            Loading business numbers...
          </p>
        </div>
      ) : error ? (
        <Card className="border-rose-200 dark:border-rose-900/50 bg-rose-50/50 dark:bg-rose-950/20">
          <div className="flex items-start gap-3 p-4">
            <AlertTriangle className="w-5 h-5 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
            <div className="flex-1">
              <h4 className="text-sm font-semibold text-rose-900 dark:text-rose-200">
                Failed to load phone numbers
              </h4>
              <p className="text-xs text-rose-700 dark:text-rose-300 mt-1">{error}</p>
              <Button
                onClick={fetchNumbers}
                variant="outline"
                className="mt-3 text-xs border-rose-300 dark:border-rose-800 text-rose-700 dark:text-rose-200"
              >
                <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
                Retry Loading
              </Button>
            </div>
          </div>
        </Card>
      ) : numbers.length === 0 ? (
        /* Empty State for zero total phone numbers */
        <Card className="border-slate-200 dark:border-slate-800">
          <div className="py-12 text-center space-y-4">
            <div className="w-12 h-12 mx-auto rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400">
              <Hash className="w-6 h-6 text-slate-400" />
            </div>
            <div className="space-y-1">
              <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                No business numbers yet
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
                Purchased or ported business phone numbers for your workspace will appear here.
              </p>
            </div>
            <div className="flex items-center justify-center gap-3 pt-2">
              <button
                onClick={() => setIsPortInModalOpen(true)}
                className="px-3.5 py-2 rounded-xl text-xs font-semibold bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-1.5 border border-slate-200 dark:border-slate-800 shadow-sm transition-all"
              >
                <ArrowUpRight className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                <span>Port In Existing Number</span>
              </button>
              <Link
                href="/numbers/marketplace"
                className="px-3.5 py-2 rounded-xl text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white flex items-center gap-1.5 shadow-sm transition-all"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Buy New Number</span>
              </Link>
            </div>
          </div>
        </Card>
      ) : (
        <div className="space-y-6">
          {/* SEARCH BAR */}
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by name or number"
              className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            />
          </div>

          {/* SEARCH RESULTS OR GROUPED SECTIONS */}
          {filteredNumbers.length === 0 ? (
            <Card className="p-8 text-center">
              <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">
                No phone numbers match &quot;{searchQuery}&quot;.
              </p>
            </Card>
          ) : (
            <div className="space-y-6">
              {/* ACTIVE NUMBERS SECTION */}
              {activeNumbers.length > 0 && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between px-1">
                    <h2 className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider flex items-center gap-2">
                      <span>Active Numbers</span>
                      <span className="px-2 py-0.5 rounded-full text-[10px] bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-bold">
                        {activeNumbers.length}
                      </span>
                    </h2>
                  </div>

                  <div className="grid grid-cols-1 gap-3">
                    {activeNumbers.map((item) => (
                      <NumberRow key={item.id} item={item} onClick={() => router.push(`/numbers/${item.id}`)} />
                    ))}
                  </div>
                </div>
              )}

              {/* INACTIVE / OTHER NUMBERS SECTION */}
              {inactiveNumbers.length > 0 && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between px-1">
                    <h2 className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider flex items-center gap-2">
                      <span>Inactive / Other Numbers</span>
                      <span className="px-2 py-0.5 rounded-full text-[10px] bg-slate-500/10 text-slate-500 dark:text-slate-400 font-bold">
                        {inactiveNumbers.length}
                      </span>
                    </h2>
                  </div>

                  <div className="grid grid-cols-1 gap-3">
                    {inactiveNumbers.map((item) => (
                      <NumberRow key={item.id} item={item} onClick={() => router.push(`/numbers/${item.id}`)} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function NumberRow({ item, onClick }: { item: PhoneNumberItem; onClick: () => void }) {
  const hasVoice = item.capabilities_voice === true;
  const hasSms = item.capabilities_sms === true;
  const hasMms = item.capabilities_mms === true;
  const hasAnyCapability = hasVoice || hasSms || hasMms;
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (item.phone_number) {
      navigator.clipboard.writeText(item.phone_number);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <Card
      hoverable
      onClick={onClick}
      className="cursor-pointer transition-all hover:border-blue-500/40 group"
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4">
        <div className="flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-xl bg-blue-600/10 text-blue-600 dark:text-blue-400 flex items-center justify-center font-mono font-bold text-sm shrink-0 border border-blue-500/20 group-hover:scale-105 transition-transform">
            <Phone className="w-5 h-5" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-bold text-base text-slate-900 dark:text-slate-100">
                {item.friendly_name || 'Business Number'}
              </span>
              {item.is_primary && (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-500/15 text-blue-700 dark:text-blue-300 border border-blue-500/30">
                  Primary
                </span>
              )}
              <span
                className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                  item.active
                    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                    : 'bg-slate-500/15 text-slate-600 dark:text-slate-400'
                }`}
              >
                {item.active ? 'Active' : 'Inactive'}
              </span>
            </div>

            <div className="flex items-center gap-2 mt-0.5">
              <span className="font-mono text-xs font-semibold text-slate-600 dark:text-slate-300">
                {item.phone_number}
              </span>
              <button
                type="button"
                onClick={handleCopy}
                title="Copy phone number"
                className="p-1 rounded text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              >
                {copied ? (
                  <span className="flex items-center gap-1 text-[10px] font-bold text-emerald-600 dark:text-emerald-400">
                    <Check className="w-3 h-3" /> Copied
                  </span>
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
              </button>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-4 justify-between sm:justify-end">
          <div className="flex items-center gap-1.5">
            {!hasAnyCapability ? (
              <span className="px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-[10px] font-medium text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700">
                No capabilities configured
              </span>
            ) : (
              <>
                {hasVoice && (
                  <span className="px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-[10px] font-bold text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700">
                    Voice
                  </span>
                )}
                {hasSms && (
                  <span className="px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-[10px] font-bold text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700">
                    SMS
                  </span>
                )}
                {hasMms && (
                  <span className="px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-[10px] font-bold text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700">
                    MMS
                  </span>
                )}
              </>
            )}
          </div>

          <div className="text-slate-400 group-hover:text-blue-500 transition-colors">
            <ChevronRight className="w-5 h-5" />
          </div>
        </div>
      </div>
    </Card>
  );
}
