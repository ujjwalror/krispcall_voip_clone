'use client';

import React, { useState, useEffect, useCallback } from 'react';
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
  Lock,
  Unlock,
  KeyRound,
  ShieldCheck,
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
  const isOwner = profile?.role === 'owner';

  // Modal States
  const [isPortOutModalOpen, setIsPortOutModalOpen] = useState<boolean>(false);
  const [isReleaseModalOpen, setIsReleaseModalOpen] = useState<boolean>(false);

  // Release Workflow State
  const [releaseEligibility, setReleaseEligibility] = useState<{
    eligible?: boolean;
    blockers?: string[];
  } | null>(null);
  const [isCheckingEligibility, setIsCheckingEligibility] = useState<boolean>(false);
  const [releaseInput, setReleaseInput] = useState<string>('');
  const [isSubmittingRelease, setIsSubmittingRelease] = useState<boolean>(false);
  const [releaseResult, setReleaseResult] = useState<{
    success?: boolean;
    customerStatus?: string;
    customerMessage?: string;
    reconciliationRequired?: boolean;
  } | null>(null);
  const [releaseError, setReleaseError] = useState<string | null>(null);

  // Port Out Workflow State
  const [portOutDetails, setPortOutDetails] = useState<{
    hasActivePortOut?: boolean;
    operation?: any;
    instructions?: any;
  } | null>(null);
  const [isLoadingPortOut, setIsLoadingPortOut] = useState<boolean>(false);
  const [isAuthorizingUnlock, setIsAuthorizingUnlock] = useState<boolean>(false);
  const [portOutError, setPortOutError] = useState<string | null>(null);
  const [portOutSuccessMsg, setPortOutSuccessMsg] = useState<string | null>(null);

  const canonicalE164 = phoneNumberE164 || '';
  const cleanCanonical = canonicalE164.replace(/\D/g, '');
  const cleanInput = releaseInput.replace(/\D/g, '');

  const isConfirmationMatched =
    releaseInput.trim() === canonicalE164 ||
    (cleanInput.length >= 7 && cleanCanonical.endsWith(cleanInput));

  // Check Release Eligibility when modal opens
  const fetchReleaseEligibility = useCallback(async () => {
    setIsCheckingEligibility(true);
    setReleaseError(null);
    try {
      const res = await fetch(`/api/phone-numbers/${phoneNumberId}/release`);
      const json = await res.json();
      if (res.ok) {
        setReleaseEligibility({
          eligible: json.eligible,
          blockers: json.blockers || [],
        });
      } else {
        setReleaseError(json.message || json.error || 'Failed to check release eligibility.');
      }
    } catch {
      setReleaseError('Network error checking release eligibility.');
    } finally {
      setIsCheckingEligibility(false);
    }
  }, [phoneNumberId]);

  // Fetch Port Out Status when modal opens
  const fetchPortOutStatus = useCallback(async () => {
    setIsLoadingPortOut(true);
    setPortOutError(null);
    try {
      const res = await fetch(`/api/phone-numbers/${phoneNumberId}/port-out`);
      const json = await res.json();
      if (res.ok) {
        setPortOutDetails(json);
      } else {
        setPortOutError(json.message || json.error || 'Failed to fetch port-out details.');
      }
    } catch {
      setPortOutError('Network error loading port-out details.');
    } finally {
      setIsLoadingPortOut(false);
    }
  }, [phoneNumberId]);

  useEffect(() => {
    if (isReleaseModalOpen) {
      fetchReleaseEligibility();
    }
  }, [isReleaseModalOpen, fetchReleaseEligibility]);

  useEffect(() => {
    if (isPortOutModalOpen) {
      fetchPortOutStatus();
    }
  }, [isPortOutModalOpen, fetchPortOutStatus]);

  // Execute Release
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
          idempotency_key: `rel-${phoneNumberId}-${Date.now()}`,
        }),
      });

      const json = await res.json();
      if (res.ok) {
        setReleaseResult({
          success: json.success ?? true,
          customerStatus: json.customerStatus || json.status || 'released',
          customerMessage: json.customerMessage || 'Release request submitted to canonical lifecycle coordinator.',
          reconciliationRequired: json.reconciliationRequired || false,
        });
      } else {
        setReleaseError(json.message || json.error || 'Voluntary release operation failed.');
      }
    } catch {
      setReleaseError('Network error registering release request.');
    } finally {
      setIsSubmittingRelease(false);
    }
  };

  // Step-Up Authorize Port Out
  const handleAuthorizePortOut = async () => {
    setIsAuthorizingUnlock(true);
    setPortOutError(null);
    setPortOutSuccessMsg(null);

    try {
      const res = await fetch(`/api/phone-numbers/${phoneNumberId}/port-out`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'authorize',
          operationId: portOutDetails?.operation?.operationId,
        }),
      });

      const json = await res.json();
      if (res.ok) {
        setPortOutSuccessMsg('Port freeze unlocked successfully. Transfer instructions and PIN have been issued.');
        fetchPortOutStatus();
      } else {
        setPortOutError(json.message || json.error || 'Step-up authorization failed.');
      }
    } catch {
      setPortOutError('Network error authorizing port-out.');
    } finally {
      setIsAuthorizingUnlock(false);
    }
  };

  // Initiate Initial Port Out Request if not active
  const handleInitiatePortOut = async () => {
    setIsAuthorizingUnlock(true);
    setPortOutError(null);
    try {
      const res = await fetch(`/api/phone-numbers/${phoneNumberId}/port-out`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idempotencyKey: `portout-${phoneNumberId}-${Date.now()}`,
        }),
      });
      const json = await res.json();
      if (res.ok) {
        setPortOutSuccessMsg('Port-out request initialized. Default port freeze is locked.');
        fetchPortOutStatus();
      } else {
        setPortOutError(json.message || json.error || 'Failed to initialize port-out request.');
      }
    } catch {
      setPortOutError('Network error initiating port-out.');
    } finally {
      setIsAuthorizingUnlock(false);
    }
  };

  return (
    <Card className="border-slate-200 dark:border-slate-800">
      <CardHeader>
        <CardTitle className="text-sm font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 text-slate-600 dark:text-slate-400" />
          <span>Number Lifecycle Authority</span>
        </CardTitle>
      </CardHeader>

      <div className="p-4 space-y-4 text-xs">
        <p className="text-slate-500 dark:text-slate-400">
          Manage carrier port-out requests and voluntary relinquishment using Phase 23 canonical coordinators.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
          {/* A. PORT OUT NUMBER */}
          <div className="p-4 rounded-xl border border-amber-200 dark:border-amber-900/60 bg-amber-50/30 dark:bg-amber-950/20 flex flex-col justify-between space-y-3">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <ArrowUpRight className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                <h4 className="font-bold text-slate-900 dark:text-slate-100">Port Out Number</h4>
              </div>
              <p className="text-[11px] text-slate-600 dark:text-slate-300 leading-relaxed">
                Transfer this phone number to another carrier. Protected by carrier Port Freeze.
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
                <span>Port Out Instructions & Security</span>
              </Button>
            </div>
          </div>

          {/* B. RELEASE NUMBER */}
          <div className="p-4 rounded-xl border border-rose-200 dark:border-rose-900/80 bg-rose-50/30 dark:bg-rose-950/20 flex flex-col justify-between space-y-3">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <Trash2 className="w-4 h-4 text-rose-600 dark:text-rose-400" />
                <h4 className="font-bold text-rose-900 dark:text-rose-200">Release Number</h4>
              </div>
              <p className="text-[11px] text-rose-700 dark:text-rose-300 leading-relaxed">
                Permanently relinquish ownership back to provider pool.
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
                  Carrier Port-Out Security & Instructions
                </h3>
              </div>
              <button
                onClick={() => setIsPortOutModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              >
                <XCircle className="w-5 h-5" />
              </button>
            </div>

            {portOutError && (
              <div className="p-3 rounded-xl bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-900 text-xs text-rose-700 dark:text-rose-300">
                {portOutError}
              </div>
            )}

            {portOutSuccessMsg && (
              <div className="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-900 text-xs text-emerald-800 dark:text-emerald-200 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                <span>{portOutSuccessMsg}</span>
              </div>
            )}

            {isLoadingPortOut ? (
              <div className="py-8 flex justify-center">
                <Loader2 className="w-6 h-6 text-amber-500 animate-spin" />
              </div>
            ) : (
              <div className="space-y-4 text-xs">
                {/* Port Freeze Status Banner */}
                <div className={`p-4 rounded-xl border flex items-start gap-3 ${
                  portOutDetails?.operation?.portOutLocked ?? true
                    ? 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900 text-amber-900 dark:text-amber-200'
                    : 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900 text-emerald-900 dark:text-emerald-200'
                }`}>
                  {portOutDetails?.operation?.portOutLocked ?? true ? (
                    <Lock className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                  ) : (
                    <Unlock className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
                  )}
                  <div className="space-y-1">
                    <span className="font-bold block">
                      {portOutDetails?.operation?.portOutLocked ?? true
                        ? 'Carrier Port Freeze Active (Locked)'
                        : 'Port-Out Unlocked & Authorized'}
                    </span>
                    <p className="text-[11px] leading-relaxed">
                      {portOutDetails?.operation?.portOutLocked ?? true
                        ? 'To prevent unauthorized carrier transfers (SIM swaps), this number is locked. An organization Owner must provide step-up authentication to issue transfer credentials.'
                        : 'Transfer credentials and PIN are unlocked and ready for your gaining provider.'}
                    </p>
                  </div>
                </div>

                {/* Canonical Instructions & Details */}
                {portOutDetails?.hasActivePortOut && portOutDetails.instructions ? (
                  <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-2">
                    <span className="font-bold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
                      <KeyRound className="w-4 h-4 text-blue-500" />
                      <span>Transfer Credentials & Info</span>
                    </span>
                    <div className="font-mono text-[11px] space-y-1 text-slate-700 dark:text-slate-300">
                      <div>Status: <span className="font-bold">{portOutDetails.operation?.canonicalState || portOutDetails.operation?.status}</span></div>
                      <div>Phone Number: <span className="font-bold">{canonicalE164}</span></div>
                      {portOutDetails.operation?.accountIdentifier && (
                        <div>Account ID: <span className="font-bold">{portOutDetails.operation.accountIdentifier}</span></div>
                      )}
                    </div>
                  </div>
                ) : null}

                {/* Action Buttons */}
                <div className="flex justify-between items-center pt-2">
                  {!portOutDetails?.hasActivePortOut ? (
                    <Button
                      onClick={handleInitiatePortOut}
                      disabled={isAuthorizingUnlock}
                      className="text-xs bg-amber-600 hover:bg-amber-700 text-white font-semibold"
                    >
                      {isAuthorizingUnlock ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : null}
                      Initialize Port-Out Request
                    </Button>
                  ) : (portOutDetails?.operation?.portOutLocked ?? true) ? (
                    <Button
                      onClick={handleAuthorizePortOut}
                      disabled={isAuthorizingUnlock || !isOwner}
                      title={!isOwner ? 'Only Workspace Owners can authorize port-out unlock' : undefined}
                      className="text-xs bg-amber-600 hover:bg-amber-700 text-white font-semibold flex items-center gap-1.5"
                    >
                      {isAuthorizingUnlock ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
                      <span>Authorize & Unlock Credentials (Owner Step-Up)</span>
                    </Button>
                  ) : null}

                  <Button
                    onClick={() => setIsPortOutModalOpen(false)}
                    variant="outline"
                    className="text-xs"
                  >
                    Close
                  </Button>
                </div>
              </div>
            )}
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
                  Voluntary Release Phone Number
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
                  <span>Release Operation Processed</span>
                </div>
                <p className="text-slate-700 dark:text-slate-300 leading-relaxed">
                  {releaseResult.customerMessage}
                </p>
                {releaseResult.reconciliationRequired && (
                  <div className="p-2.5 rounded-lg bg-amber-50 dark:bg-amber-950/50 border border-amber-200 text-amber-900 dark:text-amber-200 text-[11px]">
                    Carrier verification is currently in progress. The number will update once confirmed.
                  </div>
                )}
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
            ) : isCheckingEligibility ? (
              <div className="py-8 flex justify-center">
                <Loader2 className="w-6 h-6 text-rose-500 animate-spin" />
              </div>
            ) : (
              <div className="space-y-4 text-xs">
                {/* Eligibility & Blocker Warnings */}
                {releaseEligibility && !releaseEligibility.eligible && (
                  <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-900 text-amber-900 dark:text-amber-200 space-y-1">
                    <span className="font-bold flex items-center gap-1.5">
                      <AlertTriangle className="w-4 h-4 text-amber-600" />
                      <span>Release Blocked</span>
                    </span>
                    <ul className="list-disc list-inside text-[11px] space-y-0.5">
                      {releaseEligibility.blockers?.map((b, i) => (
                        <li key={i}>{b}</li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="p-4 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/60 space-y-2 text-rose-900 dark:text-rose-200">
                  <span className="font-bold text-sm block">Warning: Irreversible Relinquishment</span>
                  <p className="leading-relaxed">
                    Releasing <strong>{canonicalE164}</strong> will terminate inbound calls and return the number to the provider pool. Active in-flight calls block release.
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
                    disabled={!isConfirmationMatched || isSubmittingRelease || Boolean(releaseEligibility && !releaseEligibility.eligible)}
                    className={`text-xs px-4 font-semibold text-white ${
                      isConfirmationMatched && (releaseEligibility?.eligible ?? true)
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
