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
  ShieldCheck,
  Layers,
  Cpu,
} from 'lucide-react';
import { useAuth } from '@/components/providers/AuthProvider';

export interface PhoneNumberItem {
  id: string;
  phone_number: string;
  phone_number_e164: string;
  friendly_name: string | null;
  country_code: string;
  is_primary: boolean;
  // Canonical Dimensions (Phase 23D.1 / 23D.10B)
  ownership_state: string;
  service_state: string;
  porting_state: string;
  compliance_state: string;
  capabilities_state?: Record<string, { stage: string; reason?: string }>;
  // Canonical Assignment (Phase 23D.5)
  assignment_target_type: string;
  assignment_target_id: string | null;
  assigned_at?: string | null;
  provider_account_id?: string | null;
  // Compatibility Projections
  active: boolean;
  status: string;
  capabilities?: { voice?: boolean; sms?: boolean; mms?: boolean };
  inbound_routing_type?: string | null;
  inbound_routing_destination_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface SlotCapacitySummary {
  organizationId: string;
  effectiveCapacity: number | null;
  consumedSlots: number;
  activeReservations: number;
  remainingSlots: number | null;
  isOverEntitled: boolean;
  remediationRequired: boolean;
}

export default function MyNumbersPage() {
  const router = useRouter();
  const { profile } = useAuth();
  const [numbers, setNumbers] = useState<PhoneNumberItem[]>([]);
  const [slotSummary, setSlotSummary] = useState<SlotCapacitySummary | null>(null);
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
        if (json.slotSummary) {
          setSlotSummary(json.slotSummary);
        }
      } else {
        const errJson = await res.json().catch(() => ({}));
        setError(errJson.message || errJson.error || 'Failed to load business phone numbers.');
      }
    } catch {
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
      const targetType = (num.assignment_target_type || '').toLowerCase();
      return friendlyName.includes(q) || phoneNumber.includes(q) || targetType.includes(q);
    });
  }, [numbers, searchQuery]);

  // Grouped by Canonical Ownership / Service state
  const ownedNumbers = useMemo(
    () => filteredNumbers.filter((n) => n.ownership_state === 'OWNED' || (!n.ownership_state && n.active)),
    [filteredNumbers]
  );
  const pendingOrOtherNumbers = useMemo(
    () => filteredNumbers.filter((n) => n.ownership_state !== 'OWNED' && (n.ownership_state || !n.active)),
    [filteredNumbers]
  );

  return (
    <div className="space-y-6 max-w-5xl mx-auto pb-12">
      {/* Header & Primary Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <Hash className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            <span>Business Phone Numbers</span>
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Manage your organization&apos;s active phone lines, canonical routing, and carrier capacity.
          </p>
        </div>

        {/* HEADER ACTIONS */}
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
            className={`px-3.5 py-2 rounded-xl text-xs font-semibold flex items-center gap-1.5 shadow-sm transition-all ${
              slotSummary?.isOverEntitled || (slotSummary && slotSummary.remainingSlots !== null && slotSummary.remainingSlots <= 0)
                ? 'bg-slate-300 dark:bg-slate-800 text-slate-500 cursor-not-allowed pointer-events-none'
                : 'bg-blue-600 hover:bg-blue-700 text-white'
            }`}
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Buy New Number</span>
          </Link>
        </div>
      </div>

      {/* SLOT / ENTITLEMENT CAPACITY UX (Phase 23D.9 / Task 6 & 28 / Phase 23E.1A) */}
      {slotSummary && (
        <div className="space-y-3">
          {slotSummary.isOverEntitled ? (
            <div className="p-4 rounded-2xl bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800 text-amber-900 dark:text-amber-200 flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div className="space-y-1 text-xs">
                <span className="font-bold text-sm block">Workspace Over-Entitled ({slotSummary.consumedSlots} / {slotSummary.effectiveCapacity} Slots Used)</span>
                <p className="leading-relaxed">
                  Your workspace is currently consuming more number slots than contracted.
                  New number acquisitions and port-in submissions are temporarily blocked until additional line add-ons are purchased or unused numbers are voluntarily released.
                  <strong> Note:</strong> Harmless internal routing and team reassignments remain available.
                </p>
              </div>
            </div>
          ) : slotSummary.effectiveCapacity === null ? (
            <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400 flex items-center justify-center">
                  <Layers className="w-4 h-4" />
                </div>
                <div>
                  <div className="text-xs font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                    <span>Number Capacity</span>
                    <span className="font-mono text-emerald-600 dark:text-emerald-400 font-bold">
                      {slotSummary.consumedSlots} Active Number{slotSummary.consumedSlots === 1 ? '' : 's'} (Plan-Independent)
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    Phone number ownership is plan-independent and billable recurringly
                    {slotSummary.activeReservations > 0 ? ` (${slotSummary.activeReservations} reserved in flight)` : ''}.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <span className="px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-800">
                  Unconstrained
                </span>
              </div>
            </div>
          ) : (
            <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400 flex items-center justify-center">
                  <Layers className="w-4 h-4" />
                </div>
                <div>
                  <div className="text-xs font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                    <span>Number Slot Capacity</span>
                    <span className="font-mono text-blue-600 dark:text-blue-400 font-bold">
                      {slotSummary.consumedSlots} of {slotSummary.effectiveCapacity} Used
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    {slotSummary.remainingSlots} available slot{slotSummary.remainingSlots === 1 ? '' : 's'} remaining
                    {slotSummary.activeReservations > 0 ? ` (${slotSummary.activeReservations} reserved in flight)` : ''}.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <div className="w-32 h-2 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                  <div
                    className="h-full bg-blue-600 rounded-full transition-all"
                    style={{
                      width: `${Math.min(100, Math.round((slotSummary.consumedSlots / Math.max(1, slotSummary.effectiveCapacity || 1)) * 100))}%`,
                    }}
                  />
                </div>
                <span className="text-[11px] font-mono font-bold text-slate-600 dark:text-slate-400">
                  {Math.round((slotSummary.consumedSlots / Math.max(1, slotSummary.effectiveCapacity || 1)) * 100)}%
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* PORT IN EXPLANATORY MODAL */}
      {isPortInModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl max-w-lg w-full p-6 space-y-4 shadow-xl">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2">
                <ArrowUpRight className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">
                  Carrier Port-In Preparation
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
              Transfer existing business telephone numbers into VoIP Hub through our Phase 23 canonical port-in coordinator.
            </p>

            <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-2 text-xs">
              <span className="font-bold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
                <FileText className="w-4 h-4 text-blue-500" />
                <span>Porting Prerequisites</span>
              </span>
              <ul className="list-disc list-inside space-y-1 text-slate-600 dark:text-slate-300 font-mono text-[11px]">
                <li>Customer Letter of Authorization (LOA)</li>
                <li>Recent copy of carrier billing statement (within 30 days)</li>
                <li>Gaining provider account details &amp; porting PIN</li>
                <li>Committed in-flight ports reserve 1 number slot</li>
              </ul>
            </div>

            <div className="flex justify-between items-center pt-2">
              <Link
                href="/billing/numbers/port-in"
                className="text-xs bg-blue-600 hover:bg-blue-700 text-white font-semibold px-4 py-2 rounded-xl transition-all"
              >
                Go to Port-In Workspace
              </Link>
              <Button
                variant="outline"
                onClick={() => setIsPortInModalOpen(false)}
                className="text-xs"
              >
                Close
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
            Loading canonical business numbers...
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
        <Card className="border-slate-200 dark:border-slate-800">
          <div className="py-12 text-center space-y-4">
            <div className="w-12 h-12 mx-auto rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400">
              <Hash className="w-6 h-6 text-slate-400" />
            </div>
            <div className="space-y-1">
              <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                No business numbers found
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
                Acquired or ported telephone numbers for your organization will appear here.
              </p>
            </div>
            <div className="flex items-center justify-center gap-3 pt-2">
              <Link
                href="/numbers/marketplace"
                className="px-3.5 py-2 rounded-xl text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white flex items-center gap-1.5 shadow-sm transition-all"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Search Marketplace</span>
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
              placeholder="Search by name, number, or assignment..."
              className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            />
          </div>

          {filteredNumbers.length === 0 ? (
            <Card className="p-8 text-center">
              <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">
                No phone numbers match &quot;{searchQuery}&quot;.
              </p>
            </Card>
          ) : (
            <div className="space-y-6">
              {/* OWNED / ACTIVE NUMBERS */}
              {ownedNumbers.length > 0 && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between px-1">
                    <h2 className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider flex items-center gap-2">
                      <span>Active Business Lines</span>
                      <span className="px-2 py-0.5 rounded-full text-[10px] bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-bold">
                        {ownedNumbers.length}
                      </span>
                    </h2>
                  </div>

                  <div className="grid grid-cols-1 gap-3">
                    {ownedNumbers.map((item) => (
                      <CanonicalNumberRow key={item.id} item={item} onClick={() => router.push(`/numbers/${item.id}`)} />
                    ))}
                  </div>
                </div>
              )}

              {/* PENDING / OTHER NUMBERS */}
              {pendingOrOtherNumbers.length > 0 && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between px-1">
                    <h2 className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider flex items-center gap-2">
                      <span>Pending / Quarantined Lines</span>
                      <span className="px-2 py-0.5 rounded-full text-[10px] bg-amber-500/10 text-amber-600 dark:text-amber-400 font-bold">
                        {pendingOrOtherNumbers.length}
                      </span>
                    </h2>
                  </div>

                  <div className="grid grid-cols-1 gap-3">
                    {pendingOrOtherNumbers.map((item) => (
                      <CanonicalNumberRow key={item.id} item={item} onClick={() => router.push(`/numbers/${item.id}`)} />
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

function CanonicalNumberRow({ item, onClick }: { item: PhoneNumberItem; onClick: () => void }) {
  const [copied, setCopied] = useState(false);
  const isProtectedPilot = item.phone_number_e164 === '+61348328472' || item.phone_number === '+61348328472';

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (item.phone_number) {
      navigator.clipboard.writeText(item.phone_number);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const assignmentLabel = (() => {
    switch (item.assignment_target_type) {
      case 'USER':
        return 'Assigned to User';
      case 'QUEUE':
        return 'Call Queue';
      case 'IVR':
        return 'IVR Menu';
      case 'WORKSPACE_MAIN':
        return 'Workspace Main';
      case 'VOICEMAIL':
        return 'Voicemail Box';
      case 'TEAM':
        return 'Team';
      default:
        return 'Unassigned Pool';
    }
  })();

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
                {item.friendly_name || 'Business Line'}
              </span>

              {item.is_primary && (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-500/15 text-blue-700 dark:text-blue-300 border border-blue-500/30">
                  Primary
                </span>
              )}

              {/* Canonical Ownership & Service Badges */}
              <span
                className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                  item.ownership_state === 'OWNED'
                    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                    : item.ownership_state === 'RELEASE_PENDING'
                    ? 'bg-rose-500/15 text-rose-700 dark:text-rose-300'
                    : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                }`}
              >
                {item.ownership_state || 'OWNED'}
              </span>

              {item.service_state && item.service_state !== 'ACTIVE' && (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-500/15 text-slate-600 dark:text-slate-400">
                  {item.service_state}
                </span>
              )}

              {isProtectedPilot && (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-purple-500/15 text-purple-700 dark:text-purple-300 border border-purple-500/30">
                  Protected Pilot
                </span>
              )}
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
          {/* Canonical Assignment Pill */}
          <div className="flex items-center gap-1.5">
            <span className="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-[11px] font-medium text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 flex items-center gap-1">
              <Cpu className="w-3 h-3 text-blue-500" />
              <span>{assignmentLabel}</span>
            </span>
          </div>

          <div className="text-slate-400 group-hover:text-blue-500 transition-colors">
            <ChevronRight className="w-5 h-5" />
          </div>
        </div>
      </div>
    </Card>
  );
}
