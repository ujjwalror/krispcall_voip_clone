'use client';

import React, { useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import {
  ShieldAlert,
  ArrowUpRight,
  Trash2,
  AlertTriangle,
  XCircle,
  Loader2,
  CheckCircle2,
  Info,
} from 'lucide-react';
import { useAuth } from '@/components/providers/AuthProvider';

interface NumberLifecycleSettingsProps {
  phoneNumberId: string;
  phoneNumberE164: string;
  friendlyName?: string | null;
}

export function NumberLifecycleSettings({
  phoneNumberId,
  phoneNumberE164,
  friendlyName,
}: NumberLifecycleSettingsProps) {
  const { profile } = useAuth();
  const canManage = profile?.role === 'owner' || profile?.role === 'admin';

  // Modal States
  const [isPortOutModalOpen, setIsPortOutModalOpen] = useState<boolean>(false);
  const [isReleaseModalOpen, setIsReleaseModalOpen] = useState<boolean>(false);

  // Release Confirmation State
  const [releaseInput, setReleaseInput] = useState<string>('');
  const [isSubmittingRelease, setIsSubmittingRelease] = useState<boolean>(false);
  const [releaseResult, setReleaseResult] = useState<{
    success?: boolean;
    message?: string;
    status?: string;
  } | null>(null);
  const [releaseError, setReleaseError] = useState<string | null>(null);

  // Normalization for typing match (allows spaces/dashes/exact match)
  const canonicalE164 = phoneNumberE164 || '';
  const cleanCanonical = canonicalE164.replace(/\D/g, '');
  const cleanInput = releaseInput.replace(/\D/g, '');

  const isConfirmationMatched =
    releaseInput.trim() === canonicalE164 ||
    (cleanInput.length >= 7 && cleanCanonical.endsWith(cleanInput));

  const handleInitiateRelease = async () => {
    if (!isConfirmationMatched) return;
    setIsSubmittingRelease(true);
    setReleaseError(null);
    setReleaseResult(null);

    try {
      const res = await fetch(`/api/phone-numbers/${phoneNumberId}/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirm_phone_number: canonicalE164,
        }),
      });

      const json = await res.json();
      if (res.ok) {
        setReleaseResult({
          success: true,
          status: json.status || 'requested',
          message:
            'Release request registered in lifecycle foundation. Provider release mutation gate is currently OFF for safety. The phone number remains active.',
        });
      } else {
        setReleaseError(json.error || 'Voluntary release operation failed.');
      }
    } catch (err) {
      console.error('[NumberLifecycleSettings] Release submission error:', err);
      setReleaseError('Network error registering release request.');
    } finally {
      setIsSubmittingRelease(false);
    }
  };

  return (
    <Card className="border-slate-200 dark:border-slate-800">
      <CardHeader>
        <CardTitle className="text-sm font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 text-slate-600 dark:text-slate-400" />
          <span>Number Lifecycle</span>
        </CardTitle>
      </CardHeader>

      <div className="p-4 space-y-4 text-xs">
        <p className="text-slate-500 dark:text-slate-400">
          Manage carrier port-out requests or voluntary relinquishment for this business line.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
          {/* A. PORT OUT NUMBER — OUTLINED / WARNING TREATMENT */}
          <div className="p-4 rounded-xl border border-amber-200 dark:border-amber-900/60 bg-amber-50/30 dark:bg-amber-950/20 flex flex-col justify-between space-y-3">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <ArrowUpRight className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                <h4 className="font-bold text-slate-900 dark:text-slate-100">Port Out Number</h4>
              </div>
              <p className="text-[11px] text-slate-600 dark:text-slate-300 leading-relaxed">
                Move this number to another provider while keeping your number.
              </p>
            </div>

            <div className="pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIsPortOutModalOpen(true)}
                disabled={!canManage}
                className="w-full text-xs font-semibold border-amber-300 dark:border-amber-800 text-amber-900 dark:text-amber-200 hover:bg-amber-100/50 dark:hover:bg-amber-900/40"
              >
                <span>Port Out Instructions & Details</span>
              </Button>
            </div>
          </div>

          {/* B. RELEASE NUMBER — DANGER / RED TREATMENT */}
          <div className="p-4 rounded-xl border border-rose-200 dark:border-rose-900/80 bg-rose-50/30 dark:bg-rose-950/20 flex flex-col justify-between space-y-3">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <Trash2 className="w-4 h-4 text-rose-600 dark:text-rose-400" />
                <h4 className="font-bold text-rose-900 dark:text-rose-200">Release Number</h4>
              </div>
              <p className="text-[11px] text-rose-700 dark:text-rose-300 leading-relaxed">
                Permanently give up this number.
              </p>
            </div>

            <div className="pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setIsReleaseModalOpen(true);
                  setReleaseInput('');
                  setReleaseError(null);
                  setReleaseResult(null);
                }}
                disabled={!canManage}
                className="w-full text-xs font-semibold border-rose-300 dark:border-rose-900 text-rose-700 dark:text-rose-300 hover:bg-rose-100/60 dark:hover:bg-rose-950/60"
              >
                <span>Release Number...</span>
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* PORT OUT MODAL */}
      {isPortOutModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl max-w-lg w-full p-6 space-y-4 shadow-xl">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2">
                <ArrowUpRight className="w-5 h-5 text-amber-500" />
                <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">
                  Port Out Phone Number
                </h3>
              </div>
              <button
                onClick={() => setIsPortOutModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              >
                <XCircle className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/60 space-y-2 text-xs text-amber-900 dark:text-amber-200">
              <span className="font-bold block">Carrier Port Out Information</span>
              <p className="leading-relaxed">
                To transfer <strong>{canonicalE164}</strong> ({friendlyName || 'Business Number'}) to another carrier:
              </p>
              <ul className="list-disc list-inside space-y-1 pt-1 font-mono text-[11px]">
                <li>Account SID: Standard Workspace Carrier Account</li>
                <li>Letter of Authorization (LOA): Required by target carrier</li>
                <li>Service Address: Your registered workspace address</li>
              </ul>
            </div>

            <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-400 flex items-start gap-2">
              <Info className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
              <span>
                Backend carrier port-out submission is currently <strong>NOT_READY</strong>. Submitting a port request in this phase will generate ZERO provider mutations.
              </span>
            </div>

            <div className="flex justify-end pt-2">
              <Button
                onClick={() => setIsPortOutModalOpen(false)}
                className="text-xs bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 font-semibold"
              >
                Close
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* RELEASE NUMBER DANGER MODAL */}
      {isReleaseModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 border border-rose-200 dark:border-rose-900/80 rounded-2xl max-w-lg w-full p-6 space-y-4 shadow-xl">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2 text-rose-600 dark:text-rose-400">
                <AlertTriangle className="w-5 h-5" />
                <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">
                  Release Phone Number
                </h3>
              </div>
              <button
                onClick={() => setIsReleaseModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              >
                <XCircle className="w-5 h-5" />
              </button>
            </div>

            {releaseError && (
              <div className="p-3 rounded-xl bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-900 text-xs text-rose-700 dark:text-rose-300">
                {releaseError}
              </div>
            )}

            {releaseResult ? (
              <div className="p-4 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 space-y-3 text-xs">
                <div className="flex items-center gap-2 text-emerald-800 dark:text-emerald-200 font-bold">
                  <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                  <span>Release Confirmation Registered</span>
                </div>
                <p className="text-slate-700 dark:text-slate-300 leading-relaxed">
                  {releaseResult.message}
                </p>
                <div className="pt-2 flex justify-end">
                  <Button
                    size="sm"
                    onClick={() => setIsReleaseModalOpen(false)}
                    className="text-xs bg-emerald-600 text-white font-semibold"
                  >
                    Done
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-4 text-xs">
                <div className="p-4 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/60 space-y-2 text-rose-900 dark:text-rose-200">
                  <span className="font-bold text-sm block">Warning: Irreversible Action</span>
                  <p className="leading-relaxed">
                    Releasing <strong>{canonicalE164}</strong> will disconnect inbound calls and messages. This action may be permanent and the number may not be recoverable.
                  </p>
                  <p className="text-[11px] font-semibold text-rose-700 dark:text-rose-300 pt-1">
                    Note: Provider release mutation gate is OFF. No live carrier disconnection will occur in this phase.
                  </p>
                </div>

                <div className="space-y-2">
                  <label className="font-bold text-slate-900 dark:text-slate-100 block">
                    Type phone number <span className="font-mono text-rose-600">{canonicalE164}</span> to confirm:
                  </label>
                  <input
                    type="text"
                    value={releaseInput}
                    onChange={(e) => setReleaseInput(e.target.value)}
                    placeholder={canonicalE164}
                    className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 font-mono font-semibold text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-rose-500/40 text-xs"
                  />
                </div>

                <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-100 dark:border-slate-800">
                  <Button
                    variant="outline"
                    onClick={() => setIsReleaseModalOpen(false)}
                    className="text-xs px-4"
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={handleInitiateRelease}
                    disabled={!isConfirmationMatched || isSubmittingRelease}
                    className={`text-xs px-4 font-semibold text-white ${
                      isConfirmationMatched
                        ? 'bg-rose-600 hover:bg-rose-700 shadow-sm'
                        : 'bg-rose-300 dark:bg-rose-950/60 text-slate-400 cursor-not-allowed'
                    }`}
                  >
                    {isSubmittingRelease ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : null}
                    <span>Confirm Release Number</span>
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
