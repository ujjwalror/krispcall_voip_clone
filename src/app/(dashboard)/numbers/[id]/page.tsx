'use client';

import React, { useEffect, useState, useCallback, use } from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import {
  ArrowLeft,
  Phone,
  AlertTriangle,
  Loader2,
  RefreshCw,
  Star,
  Edit2,
  Check,
  X,
  Users,
  UserCheck,
  UserX,
  Copy,
  Plus,
  XCircle,
  ExternalLink,
  ShieldCheck,
} from 'lucide-react';
import { PhoneNumberItem } from '../page';
import { useAuth } from '@/components/providers/AuthProvider';
import { NumberNotificationsSettings } from '@/components/numbers/NumberNotificationsSettings';
import { GreetingsAudioSettings } from '@/components/numbers/GreetingsAudioSettings';
import { NumberLifecycleSettings } from '@/components/numbers/NumberLifecycleSettings';

export interface AssignmentMember {
  id: string;
  full_name: string;
  email: string;
  role: string;
  active: boolean;
  avatar_url?: string | null;
  is_assigned: boolean;
}

export interface IvrMenuOption {
  id: string;
  name: string;
  enabled: boolean;
  greetingText?: string;
}

export default function NumberDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = use(params);
  const numberId = resolvedParams.id;
  const { profile } = useAuth();

  const [phoneNumber, setPhoneNumber] = useState<PhoneNumberItem | null>(null);
  const [allOrgNumbers, setAllOrgNumbers] = useState<PhoneNumberItem[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Friendly Name Editing & Copy State
  const [isEditingFriendlyName, setIsEditingFriendlyName] = useState<boolean>(false);
  const [friendlyNameInput, setFriendlyNameInput] = useState<string>('');
  const [isSavingFriendlyName, setIsSavingFriendlyName] = useState<boolean>(false);
  const [copiedNumber, setCopiedNumber] = useState<boolean>(false);

  // Caller ID Selection & Mutation State
  const [selectedDefaultCallerId, setSelectedDefaultCallerId] = useState<string>('');
  const [isUpdatingCallerId, setIsUpdatingCallerId] = useState<boolean>(false);

  // External Caller ID Verification Modal State
  const [isExternalModalOpen, setIsExternalModalOpen] = useState<boolean>(false);
  const [externalCountryCode, setExternalCountryCode] = useState<string>('+1');
  const [externalPhoneNumber, setExternalPhoneNumber] = useState<string>('');
  const [isSubmittingExternal, setIsSubmittingExternal] = useState<boolean>(false);
  const [externalModalError, setExternalModalError] = useState<string | null>(null);
  const [externalVerificationResult, setExternalVerificationResult] = useState<{
    validationCode?: string;
    customerMessage?: string;
    alreadyOwned?: boolean;
  } | null>(null);

  // Mutation & Banner Messages
  const [mutationError, setMutationError] = useState<string | null>(null);

  // Shared Access / Assignment States
  const [assignmentMembers, setAssignmentMembers] = useState<AssignmentMember[]>([]);
  const [isAssignedToSelf, setIsAssignedToSelf] = useState<boolean>(false);
  const [isLoadingAssignments, setIsLoadingAssignments] = useState<boolean>(true);
  const [togglingUserIds, setTogglingUserIds] = useState<Record<string, boolean>>({});

  // Incoming Strategy State (Compact Radio: 'user' | 'forward' | 'ivr')
  const [strategyTab, setStrategyTab] = useState<'user' | 'forward' | 'ivr'>('user');
  const [isSavingStrategy, setIsSavingStrategy] = useState<boolean>(false);
  const [strategySuccessMsg, setStrategySuccessMsg] = useState<string | null>(null);

  // Web & Phone Unanswered Strategy (Default: 'dismiss')
  const [unansweredCallStrategy, setUnansweredCallStrategy] = useState<string>('dismiss');

  // Forwarding UI Foundation State
  const [forwardCountryCode, setForwardCountryCode] = useState<string>('+1');
  const [forwardDestinationNumber, setForwardDestinationNumber] = useState<string>('');

  // IVR Menu Integration State
  const [ivrMenus, setIvrMenus] = useState<IvrMenuOption[]>([]);
  const [isIvrEntitled, setIsIvrEntitled] = useState<boolean>(false);
  const [isVoicemailEntitled, setIsVoicemailEntitled] = useState<boolean>(false);
  const [isLoadingIvrMenus, setIsLoadingIvrMenus] = useState<boolean>(false);
  const [selectedIvrMenuId, setSelectedIvrMenuId] = useState<string>('');

  const canManageNumbers = profile?.role === 'owner' || profile?.role === 'admin';

  // Fetch Single Phone Number Detail
  const fetchNumberDetail = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/phone-numbers/${numberId}`);
      if (res.ok) {
        const json = await res.json();
        const num = json.phoneNumber || null;
        setPhoneNumber(num);
        if (num) {
          setFriendlyNameInput(num.friendly_name || '');
          if (num.unanswered_call_strategy) {
            setUnansweredCallStrategy(num.unanswered_call_strategy);
          }
          const currentRouting = num.inbound_routing_type || 'user';
          if (currentRouting === 'ivr') {
            setStrategyTab('ivr');
            if (num.inbound_routing_destination_id) {
              setSelectedIvrMenuId(num.inbound_routing_destination_id);
            }
          } else {
            setStrategyTab('user');
          }
        }
      } else {
        const errJson = await res.json().catch(() => ({}));
        setError(errJson.message || 'Phone number record not found or access denied.');
      }
    } catch (err) {
      console.error('[NumberDetailPage] Error fetching number details:', err);
      setError('Network error loading phone number details. Please try again.');
    } finally {
      setIsLoading(false);
    }
  }, [numberId]);

  // Fetch All Workspace Authorized Numbers for Caller ID Dropdown
  const fetchAllOrgNumbers = useCallback(async () => {
    try {
      const res = await fetch('/api/phone-numbers');
      if (res.ok) {
        const json = await res.json();
        const list: PhoneNumberItem[] = json.phoneNumbers || [];
        setAllOrgNumbers(list);
        const primary = list.find((n) => n.is_primary) || list[0];
        if (primary) {
          setSelectedDefaultCallerId(primary.id);
        }
      }
    } catch (err) {
      console.error('[NumberDetailPage] Error fetching all workspace numbers:', err);
    }
  }, []);

  // Fetch Team Assignments
  const fetchAssignments = useCallback(async () => {
    setIsLoadingAssignments(true);
    try {
      const res = await fetch(`/api/phone-numbers/${numberId}/assignments`);
      if (res.ok) {
        const json = await res.json();
        if (json.canManage) {
          setAssignmentMembers(json.members || []);
        } else {
          setIsAssignedToSelf(Boolean(json.isAssigned));
        }
      }
    } catch (err) {
      console.error('[NumberDetailPage] Error fetching assignments:', err);
    } finally {
      setIsLoadingAssignments(false);
    }
  }, [numberId]);

  // Fetch IVR Menus & Entitlements
  const fetchIvrMenus = useCallback(async () => {
    setIsLoadingIvrMenus(true);
    try {
      const res = await fetch('/api/ivr');
      if (res.ok) {
        const json = await res.json();
        setIsIvrEntitled(Boolean(json.entitled));
        setIvrMenus(json.menus || []);
        if (json.menus && json.menus.length > 0 && !selectedIvrMenuId) {
          setSelectedIvrMenuId(json.menus[0].id);
        }
      }
    } catch (err) {
      console.error('[NumberDetailPage] Error fetching IVR menus:', err);
    } finally {
      setIsLoadingIvrMenus(false);
    }
  }, [selectedIvrMenuId]);

  const fetchVoicemailEntitlement = useCallback(async () => {
    try {
      const res = await fetch('/api/voicemails');
      if (res.status === 403) {
        setIsVoicemailEntitled(false);
      } else if (res.ok) {
        setIsVoicemailEntitled(true);
      }
    } catch {
      setIsVoicemailEntitled(false);
    }
  }, []);

  useEffect(() => {
    fetchNumberDetail();
    fetchAllOrgNumbers();
    fetchAssignments();
    fetchIvrMenus();
    fetchVoicemailEntitlement();
  }, [fetchNumberDetail, fetchAllOrgNumbers, fetchAssignments, fetchIvrMenus, fetchVoicemailEntitlement]);

  // Copy E.164 Action
  const handleCopyNumber = () => {
    if (phoneNumber?.phone_number) {
      navigator.clipboard.writeText(phoneNumber.phone_number);
      setCopiedNumber(true);
      setTimeout(() => setCopiedNumber(false), 2000);
    }
  };

  // Toggle Assignment
  const handleToggleAssignment = async (targetUserId: string, currentAssigned: boolean) => {
    setTogglingUserIds((prev) => ({ ...prev, [targetUserId]: true }));
    setMutationError(null);
    try {
      const method = currentAssigned ? 'DELETE' : 'POST';
      const res = await fetch(`/api/phone-numbers/${numberId}/assignments`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: targetUserId }),
      });

      const json = await res.json();
      if (res.ok && json.success) {
        setAssignmentMembers((prev) =>
          prev.map((m) => (m.id === targetUserId ? { ...m, is_assigned: !currentAssigned } : m))
        );
      } else {
        setMutationError(json.message || 'Failed to update team member assignment.');
      }
    } catch (err: any) {
      console.error('[NumberDetailPage] Toggle assignment error:', err);
      setMutationError('Network error updating assignment.');
    } finally {
      setIsLoadingAssignments(false);
      setTogglingUserIds((prev) => ({ ...prev, [targetUserId]: false }));
    }
  };

  // Save Friendly Name
  const handleSaveFriendlyName = async () => {
    if (!phoneNumber) return;
    setIsSavingFriendlyName(true);
    setMutationError(null);
    try {
      const res = await fetch(`/api/phone-numbers/${numberId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ friendlyName: friendlyNameInput }),
      });

      const json = await res.json();
      if (res.ok && json.phoneNumber) {
        setPhoneNumber(json.phoneNumber);
        setFriendlyNameInput(json.phoneNumber.friendly_name || '');
        setIsEditingFriendlyName(false);
      } else {
        setMutationError(json.message || 'Failed to update friendly name.');
      }
    } catch (err: any) {
      console.error('[NumberDetailPage] Friendly name save error:', err);
      setMutationError('Network error updating friendly name.');
    } finally {
      setIsSavingFriendlyName(false);
    }
  };

  // Handle Default Caller ID Selection Change
  const handleSelectDefaultCallerId = async (targetPhoneId: string) => {
    setSelectedDefaultCallerId(targetPhoneId);
    setIsUpdatingCallerId(true);
    setMutationError(null);
    try {
      const res = await fetch(`/api/phone-numbers/${targetPhoneId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isPrimary: true }),
      });

      const json = await res.json();
      if (res.ok && json.phoneNumber) {
        setAllOrgNumbers((prev) =>
          prev.map((n) => ({
            ...n,
            is_primary: n.id === targetPhoneId,
          }))
        );
        if (phoneNumber && phoneNumber.id === targetPhoneId) {
          setPhoneNumber((prev) => (prev ? { ...prev, is_primary: true } : null));
        } else if (phoneNumber) {
          setPhoneNumber((prev) => (prev ? { ...prev, is_primary: false } : null));
        }
      } else {
        setMutationError(json.message || 'Failed to update default workspace caller ID.');
      }
    } catch (err: any) {
      console.error('[NumberDetailPage] Caller ID selection error:', err);
      setMutationError('Network error updating caller ID.');
    } finally {
      setIsUpdatingCallerId(false);
    }
  };

  // Submit External Caller ID Verification Request
  const handleVerifyExternalNumber = async () => {
    setIsSubmittingExternal(true);
    setExternalModalError(null);
    setExternalVerificationResult(null);

    try {
      const res = await fetch('/api/phone-numbers/verify-caller-id', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          countryCode: externalCountryCode,
          phoneNumber: externalPhoneNumber,
        }),
      });

      const json = await res.json();
      if (res.ok && json.success) {
        if (json.alreadyOwned) {
          setExternalVerificationResult({
            alreadyOwned: true,
            customerMessage: json.message,
          });
        } else if (json.verification) {
          setExternalVerificationResult({
            validationCode: json.verification.validationCode,
            customerMessage: json.verification.customerMessage,
          });
        }
      } else {
        setExternalModalError(json.message || 'Failed to register caller ID verification request.');
      }
    } catch (err: any) {
      console.error('[NumberDetailPage] External verification error:', err);
      setExternalModalError('Network error submitting verification request.');
    } finally {
      setIsSubmittingExternal(false);
    }
  };

  // Save Incoming Strategy (User Web & Phone or IVR Call Menu)
  const handleSaveIncomingStrategy = async (targetStrategy: 'user' | 'ivr') => {
    if (!phoneNumber) return;
    setIsSavingStrategy(true);
    setMutationError(null);
    setStrategySuccessMsg(null);

    let destinationId: string | null = null;
    if (targetStrategy === 'ivr') {
      if (!selectedIvrMenuId) {
        setMutationError('Please select a valid IVR Call Menu.');
        setIsSavingStrategy(false);
        return;
      }
      destinationId = selectedIvrMenuId;
    }

    try {
      const res = await fetch(`/api/phone-numbers/${numberId}/routing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          routingType: targetStrategy,
          destinationId,
          unansweredCallStrategy,
        }),
      });

      const json = await res.json();
      if (res.ok && json.result?.success) {
        setPhoneNumber((prev) =>
          prev
            ? {
                ...prev,
                inbound_routing_type: targetStrategy,
                inbound_routing_destination_id: destinationId,
                unanswered_call_strategy: unansweredCallStrategy,
              }
            : null
        );
        setStrategySuccessMsg(
          targetStrategy === 'user'
            ? 'Incoming strategy set to Web & Phone.'
            : 'Incoming strategy set to Call Menu (IVR).'
        );
        setTimeout(() => setStrategySuccessMsg(null), 4000);
      } else {
        setMutationError(json.message || 'Failed to update incoming call strategy.');
      }
    } catch (err: any) {
      console.error('[NumberDetailPage] Strategy update error:', err);
      setMutationError('Network error saving incoming strategy.');
    } finally {
      setIsSavingStrategy(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 space-y-4 max-w-5xl mx-auto">
        <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
        <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">
          Loading phone number configuration...
        </p>
      </div>
    );
  }

  if (error || !phoneNumber) {
    return (
      <div className="max-w-5xl mx-auto space-y-6">
        <Link
          href="/numbers"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to My Numbers</span>
        </Link>
        <Card className="border-rose-200 dark:border-rose-900/50 bg-rose-50/50 dark:bg-rose-950/20">
          <div className="flex items-start gap-3 p-4">
            <AlertTriangle className="w-5 h-5 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
            <div className="flex-1">
              <h4 className="text-sm font-semibold text-rose-900 dark:text-rose-200">
                Number Not Found or Access Denied
              </h4>
              <p className="text-xs text-rose-700 dark:text-rose-300 mt-1">
                {error || 'The requested phone number does not exist or does not belong to your workspace.'}
              </p>
              <Button
                onClick={fetchNumberDetail}
                variant="outline"
                className="mt-3 text-xs border-rose-300 dark:border-rose-800 text-rose-700 dark:text-rose-200"
              >
                <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
                Retry
              </Button>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  const hasVoice = phoneNumber.capabilities_voice === true;
  const hasSms = phoneNumber.capabilities_sms === true;
  const hasMms = phoneNumber.capabilities_mms === true;
  const hasAnyCapability = hasVoice || hasSms || hasMms;

  return (
    <div className="space-y-6 max-w-5xl mx-auto pb-16">
      {/* Top Navigation Back */}
      <div>
        <Link
          href="/numbers"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline mb-2"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to My Numbers</span>
        </Link>
      </div>

      {/* Management Error Alert Banner */}
      {mutationError && (
        <div className="p-4 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800/80 text-xs text-rose-800 dark:text-rose-300 flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
          <div className="flex-1">
            <span className="font-semibold block mb-0.5">Error</span>
            <span>{mutationError}</span>
          </div>
          <button
            onClick={() => setMutationError(null)}
            className="text-rose-500 hover:text-rose-700 dark:hover:text-rose-100"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Strategy Success Alert Banner */}
      {strategySuccessMsg && (
        <div className="p-4 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/80 text-xs text-emerald-800 dark:text-emerald-300 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Check className="w-4 h-4 text-emerald-500" />
            <span className="font-semibold">{strategySuccessMsg}</span>
          </div>
          <button onClick={() => setStrategySuccessMsg(null)} className="text-emerald-500">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* 1. NUMBER CARD / NUMBER DETAILS */}
      <Card className="border-slate-200 dark:border-slate-800 bg-gradient-to-br from-white via-slate-50/50 to-blue-50/20 dark:from-slate-900 dark:via-slate-900/95 dark:to-blue-950/20">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 p-6">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-xl bg-blue-600/15 text-blue-600 dark:text-blue-400 flex items-center justify-center font-mono font-bold text-base border border-blue-500/20 shrink-0">
              <Phone className="w-6 h-6" />
            </div>

            <div className="space-y-1">
              {/* Prominent Friendly Name with Inline Editing */}
              <div className="flex items-center gap-2">
                {isEditingFriendlyName ? (
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      maxLength={100}
                      value={friendlyNameInput}
                      onChange={(e) => setFriendlyNameInput(e.target.value)}
                      placeholder="e.g. Sales Support Line"
                      className="px-2.5 py-1 rounded-lg text-sm font-bold bg-white dark:bg-slate-900 border border-blue-500 text-slate-900 dark:text-slate-100 focus:outline-none w-56 sm:w-72"
                      disabled={isSavingFriendlyName}
                    />
                    <button
                      onClick={handleSaveFriendlyName}
                      disabled={isSavingFriendlyName}
                      className="p-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors"
                      title="Save Friendly Name"
                    >
                      {isSavingFriendlyName ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                    </button>
                    <button
                      onClick={() => {
                        setIsEditingFriendlyName(false);
                        setFriendlyNameInput(phoneNumber.friendly_name || '');
                      }}
                      disabled={isSavingFriendlyName}
                      className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
                      title="Cancel"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100 tracking-tight">
                      {phoneNumber.friendly_name || 'Business Number'}
                    </h1>
                    {canManageNumbers && (
                      <button
                        onClick={() => {
                          setFriendlyNameInput(phoneNumber.friendly_name || '');
                          setIsEditingFriendlyName(true);
                          setMutationError(null);
                        }}
                        className="p-1 text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                        title="Edit Friendly Name"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                )}

                {phoneNumber.is_primary && (
                  <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-blue-500/15 text-blue-700 dark:text-blue-300 border border-blue-500/30 flex items-center gap-1 shrink-0">
                    <Star className="w-3 h-3 fill-current text-blue-500" />
                    <span>Primary Line</span>
                  </span>
                )}
                <span
                  className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold capitalize shrink-0 ${
                    phoneNumber.active
                      ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                      : 'bg-slate-500/15 text-slate-600 dark:text-slate-400'
                  }`}
                >
                  {phoneNumber.active ? 'Active' : 'Inactive'}
                </span>
              </div>

              {/* E.164 Telephone Number + Copy Action */}
              <div className="flex items-center gap-2 pt-0.5">
                <span className="font-mono text-sm font-semibold text-slate-600 dark:text-slate-300">
                  {phoneNumber.phone_number}
                </span>
                <button
                  type="button"
                  onClick={handleCopyNumber}
                  className="p-1 rounded text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors inline-flex items-center gap-1"
                  title="Copy telephone number"
                >
                  {copiedNumber ? (
                    <span className="flex items-center gap-1 text-[10px] font-bold text-emerald-600 dark:text-emerald-400">
                      <Check className="w-3 h-3" /> Copied!
                    </span>
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
            </div>
          </div>

          {/* Capabilities */}
          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <div className="flex items-center gap-1.5">
              {!hasAnyCapability ? (
                <span className="px-2.5 py-1 rounded-md bg-slate-100 dark:bg-slate-800 text-xs font-medium text-slate-500 border border-slate-200 dark:border-slate-700">
                  No capabilities
                </span>
              ) : (
                <>
                  {hasVoice && (
                    <span className="px-2.5 py-1 rounded-md bg-slate-100 dark:bg-slate-800 text-xs font-bold text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700">
                      Voice
                    </span>
                  )}
                  {hasSms && (
                    <span className="px-2.5 py-1 rounded-md bg-slate-100 dark:bg-slate-800 text-xs font-bold text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700">
                      SMS
                    </span>
                  )}
                  {hasMms && (
                    <span className="px-2.5 py-1 rounded-md bg-slate-100 dark:bg-slate-800 text-xs font-bold text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700">
                      MMS
                    </span>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </Card>

      {/* 2. NOTIFICATIONS (NEW - ABOVE CALLER ID) */}
      <NumberNotificationsSettings phoneNumberId={numberId} />

      {/* 3. CALLER ID */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-bold text-slate-900 dark:text-slate-100">
            Caller ID
          </CardTitle>
        </CardHeader>
        <div className="p-4 space-y-4 text-xs">
          <p className="text-slate-500 dark:text-slate-400">
            Choose the phone number people see when you call.
          </p>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-1">
            {/* Default Caller ID Dropdown */}
            <div className="flex-1 max-w-md space-y-1.5">
              <label className="font-semibold text-slate-700 dark:text-slate-300 block">
                Default Caller ID
              </label>
              <div className="relative">
                <select
                  value={selectedDefaultCallerId}
                  onChange={(e) => handleSelectDefaultCallerId(e.target.value)}
                  disabled={isUpdatingCallerId || !canManageNumbers}
                  className="w-full px-3 py-2.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none text-xs font-semibold pr-8"
                >
                  {allOrgNumbers.map((num) => (
                    <option key={num.id} value={num.id}>
                      {num.friendly_name || 'Business Number'} ({num.phone_number})
                      {num.is_primary ? ' — Default' : ''}
                    </option>
                  ))}
                </select>
                {isUpdatingCallerId && (
                  <Loader2 className="w-4 h-4 text-blue-500 animate-spin absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                )}
              </div>
            </div>

            {/* + Add External Number Button */}
            <div className="shrink-0 pt-5 sm:pt-0">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setIsExternalModalOpen(true);
                  setExternalModalError(null);
                  setExternalVerificationResult(null);
                }}
                disabled={!canManageNumbers}
                className="text-xs font-semibold text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-900/60 hover:bg-blue-50 dark:hover:bg-blue-950/40 flex items-center gap-1.5"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add External Number</span>
              </Button>
            </div>
          </div>
        </div>
      </Card>

      {/* VERIFY EXTERNAL CALLER ID MODAL */}
      {isExternalModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-xl animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100">
                  Verify External Caller ID
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-snug">
                  Add a phone number you own or are authorized to use as your outgoing Caller ID.
                </p>
              </div>
              <button
                onClick={() => setIsExternalModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1"
              >
                <XCircle className="w-5 h-5" />
              </button>
            </div>

            {externalModalError && (
              <div className="p-3 rounded-xl bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-900 text-xs text-rose-700 dark:text-rose-300">
                {externalModalError}
              </div>
            )}

            {externalVerificationResult ? (
              <div className="p-4 rounded-xl bg-blue-50 dark:bg-blue-950/50 border border-blue-200 dark:border-blue-900 space-y-3 text-xs">
                {externalVerificationResult.alreadyOwned ? (
                  <div className="space-y-1">
                    <span className="font-bold text-blue-900 dark:text-blue-200 block">Number Already Authorized</span>
                    <p className="text-slate-700 dark:text-slate-300">
                      {externalVerificationResult.customerMessage}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <span className="font-bold text-blue-900 dark:text-blue-200 block">
                      Verification Request Registered
                    </span>
                    <p className="text-slate-700 dark:text-slate-300 leading-relaxed">
                      {externalVerificationResult.customerMessage}
                    </p>
                    {externalVerificationResult.validationCode && (
                      <div className="p-3 rounded-lg bg-white dark:bg-slate-900 border border-blue-300 dark:border-blue-800 text-center space-y-1">
                        <span className="text-[10px] uppercase tracking-wider font-semibold text-slate-500 block">
                          Validation Code Placeholder
                        </span>
                        <span className="font-mono text-2xl font-extrabold text-blue-600 dark:text-blue-400">
                          {externalVerificationResult.validationCode}
                        </span>
                      </div>
                    )}
                  </div>
                )}
                <div className="pt-2 flex justify-end">
                  <Button
                    size="sm"
                    onClick={() => setIsExternalModalOpen(false)}
                    className="text-xs bg-blue-600 text-white font-semibold"
                  >
                    Done
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-4 text-xs pt-1">
                <div className="space-y-1">
                  <label className="font-bold text-slate-900 dark:text-slate-100 block">
                    Country Code
                  </label>
                  <select
                    value={externalCountryCode}
                    onChange={(e) => setExternalCountryCode(e.target.value)}
                    className="w-full px-3 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none text-xs font-semibold"
                  >
                    <option value="+1">United States / Canada (+1)</option>
                    <option value="+44">United Kingdom (+44)</option>
                    <option value="+61">Australia (+61)</option>
                    <option value="+91">India (+91)</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="font-bold text-slate-900 dark:text-slate-100 block">
                    Phone Number
                  </label>
                  <input
                    type="tel"
                    value={externalPhoneNumber}
                    onChange={(e) => setExternalPhoneNumber(e.target.value)}
                    placeholder="e.g. (555) 000-1234 or +15550001234"
                    className="w-full px-3 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none text-xs font-mono font-semibold"
                  />
                </div>

                <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-100 dark:border-slate-800">
                  <Button
                    variant="outline"
                    onClick={() => setIsExternalModalOpen(false)}
                    className="text-xs px-4"
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={handleVerifyExternalNumber}
                    disabled={isSubmittingExternal || !externalPhoneNumber.trim()}
                    className="text-xs px-4 bg-blue-600 hover:bg-blue-700 text-white font-semibold flex items-center gap-1.5"
                  >
                    {isSubmittingExternal ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : null}
                    <span>Verify Number</span>
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 4. SHARED ACCESS & 5. TEAM MEMBER ASSIGNMENT */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center justify-between">
            <span className="flex items-center gap-2">
              <Users className="w-4 h-4 text-blue-500" />
              <span>Shared Access & Team Member Assignment</span>
            </span>
            <span className="text-[10px] font-semibold text-slate-400">
              {canManageNumbers ? 'Owner / Admin Control' : 'Read-Only Access'}
            </span>
          </CardTitle>
        </CardHeader>
        <div className="p-4 space-y-4">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Choose which active eligible team members in your workspace can use this business number for outbound caller ID and receive inbound calls.
          </p>

          {isLoadingAssignments ? (
            <div className="flex items-center justify-center py-6 space-y-2">
              <Loader2 className="w-5 h-5 text-blue-500 animate-spin" />
              <span className="text-xs text-slate-400 ml-2">Loading member access...</span>
            </div>
          ) : canManageNumbers ? (
            assignmentMembers.length === 0 ? (
              <p className="text-xs text-slate-400 italic">No active workspace members found.</p>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200/60 dark:border-slate-800/60 rounded-xl overflow-hidden">
                {assignmentMembers.map((member) => {
                  const isToggling = Boolean(togglingUserIds[member.id]);
                  const isOperational = phoneNumber.active === true && phoneNumber.status === 'active';

                  return (
                    <div
                      key={member.id}
                      className="p-3.5 bg-slate-50/50 dark:bg-slate-900/30 flex items-center justify-between gap-4"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-950/60 border border-blue-200 dark:border-blue-800 flex items-center justify-center text-blue-700 dark:text-blue-300 font-bold text-xs shrink-0">
                          {member.full_name?.charAt(0).toUpperCase() || 'U'}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
                              {member.full_name}
                            </span>
                            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 capitalize">
                              {member.role}
                            </span>
                          </div>
                          <span className="text-[11px] text-slate-500 dark:text-slate-400 truncate block">
                            {member.email}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-3 shrink-0">
                        {member.is_assigned ? (
                          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 px-2.5 py-1 rounded-full border border-emerald-200 dark:border-emerald-800/60">
                            <UserCheck className="w-3.5 h-3.5" />
                            Assigned
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-400 bg-slate-100 dark:bg-slate-800/40 px-2.5 py-1 rounded-full border border-slate-200 dark:border-slate-800/60">
                            <UserX className="w-3.5 h-3.5" />
                            Unassigned
                          </span>
                        )}

                        <Button
                          size="sm"
                          variant={member.is_assigned ? 'outline' : 'primary'}
                          disabled={isToggling || !isOperational}
                          onClick={() => handleToggleAssignment(member.id, member.is_assigned)}
                          className="text-xs px-3 h-8"
                        >
                          {isToggling ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : member.is_assigned ? (
                            'Remove'
                          ) : (
                            'Assign'
                          )}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )
          ) : (
            <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-900/50 border border-slate-200/60 dark:border-slate-800/60 flex items-center justify-between">
              <span className="text-xs text-slate-600 dark:text-slate-400">Your Account Access</span>
              {isAssignedToSelf ? (
                <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 px-3 py-1 rounded-full border border-emerald-200 dark:border-emerald-800">
                  <UserCheck className="w-3.5 h-3.5" />
                  Assigned to your user account
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 bg-slate-100 dark:bg-slate-800 px-3 py-1 rounded-full border border-slate-200 dark:border-slate-700">
                  <UserX className="w-3.5 h-3.5" />
                  Not assigned to your user account
                </span>
              )}
            </div>
          )}
        </div>
      </Card>

      {/* 6. INCOMING CALL STRATEGY */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-bold text-slate-900 dark:text-slate-100">
            Incoming Call Strategy
          </CardTitle>
        </CardHeader>
        <div className="p-4 space-y-5">
          {/* Compact Radio / Segmented Selector */}
          <div className="inline-flex p-1 rounded-xl bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 w-full sm:w-auto">
            <button
              type="button"
              onClick={() => setStrategyTab('user')}
              className={`px-4 py-2 rounded-lg text-xs font-bold transition-all flex-1 sm:flex-initial text-center ${
                strategyTab === 'user'
                  ? 'bg-white dark:bg-slate-800 text-blue-600 dark:text-blue-400 shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              Web & Phone
            </button>
            <button
              type="button"
              onClick={() => setStrategyTab('forward')}
              className={`px-4 py-2 rounded-lg text-xs font-bold transition-all flex-1 sm:flex-initial text-center ${
                strategyTab === 'forward'
                  ? 'bg-white dark:bg-slate-800 text-blue-600 dark:text-blue-400 shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              Forward Calls
            </button>
            <button
              type="button"
              onClick={() => setStrategyTab('ivr')}
              className={`px-4 py-2 rounded-lg text-xs font-bold transition-all flex-1 sm:flex-initial text-center ${
                strategyTab === 'ivr'
                  ? 'bg-white dark:bg-slate-800 text-blue-600 dark:text-blue-400 shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              Call Menu (IVR)
            </button>
          </div>

          {/* STRATEGY PANEL 1 — WEB & PHONE */}
          {strategyTab === 'user' && (
            <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60 space-y-4 text-xs">
              <div className="space-y-1.5 max-w-sm">
                <label className="font-bold text-slate-900 dark:text-slate-100 block">
                  If unanswered
                </label>
                <select
                  value={unansweredCallStrategy}
                  onChange={(e) => setUnansweredCallStrategy(e.target.value)}
                  className="w-full px-3 py-2.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none text-xs font-semibold"
                >
                  <option value="dismiss">Dismiss Call</option>
                  {isVoicemailEntitled ? (
                    <option value="voicemail">Voicemail</option>
                  ) : (
                    <option value="voicemail" disabled>
                      Voicemail — Upgrade Required (Pro/Business)
                    </option>
                  )}
                </select>
              </div>

              {canManageNumbers && (
                <div className="pt-2 flex justify-end">
                  <Button
                    size="sm"
                    onClick={() => handleSaveIncomingStrategy('user')}
                    disabled={isSavingStrategy}
                    className="text-xs bg-blue-600 hover:bg-blue-700 text-white font-semibold"
                  >
                    {isSavingStrategy ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : null}
                    <span>Save Strategy</span>
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* STRATEGY PANEL 2 — FORWARD CALLS */}
          {strategyTab === 'forward' && (
            <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60 space-y-4 text-xs">
              <div className="space-y-3">
                <label className="font-bold text-slate-900 dark:text-slate-100 block">
                  Forward calls to
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-md">
                  <select
                    value={forwardCountryCode}
                    onChange={(e) => setForwardCountryCode(e.target.value)}
                    className="w-full px-3 py-2.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none text-xs font-semibold"
                  >
                    <option value="+1">United States / Canada (+1)</option>
                    <option value="+44">United Kingdom (+44)</option>
                    <option value="+61">Australia (+61)</option>
                    <option value="+91">India (+91)</option>
                  </select>

                  <input
                    type="tel"
                    value={forwardDestinationNumber}
                    onChange={(e) => setForwardDestinationNumber(e.target.value)}
                    placeholder="Phone Number"
                    className="w-full px-3 py-2.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none text-xs font-mono font-semibold"
                  />
                </div>
              </div>

              <div className="space-y-1.5 max-w-sm pt-1">
                <label className="font-bold text-slate-900 dark:text-slate-100 block">
                  If unanswered
                </label>
                <select
                  value={unansweredCallStrategy}
                  onChange={(e) => setUnansweredCallStrategy(e.target.value)}
                  className="w-full px-3 py-2.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none text-xs font-semibold"
                >
                  <option value="dismiss">Dismiss Call</option>
                  {isVoicemailEntitled ? (
                    <option value="voicemail">Voicemail</option>
                  ) : (
                    <option value="voicemail" disabled>
                      Voicemail — Upgrade Required (Pro/Business)
                    </option>
                  )}
                </select>
              </div>

              <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/60 text-amber-800 dark:text-amber-300 text-[11px]">
                Call forwarding will be available in an upcoming release.
              </div>

              <div className="pt-2 flex justify-end">
                <Button
                  disabled
                  className="text-xs bg-slate-200 dark:bg-slate-800 text-slate-400 dark:text-slate-500 font-semibold cursor-not-allowed border border-slate-300 dark:border-slate-700"
                >
                  <span>Forwarding Unavailable</span>
                </Button>
              </div>
            </div>
          )}

          {/* STRATEGY PANEL 3 — CALL MENU (IVR) */}
          {strategyTab === 'ivr' && (
            <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60 space-y-4 text-xs">
              {!isIvrEntitled ? (
                <div className="p-3.5 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/60 text-amber-800 dark:text-amber-300 text-xs">
                  Call Menu (IVR) is available on the <strong>Pro</strong> subscription plan.
                </div>
              ) : isLoadingIvrMenus ? (
                <div className="flex items-center justify-center py-6 space-y-2">
                  <Loader2 className="w-5 h-5 text-blue-500 animate-spin" />
                  <span className="text-xs text-slate-400 ml-2">Loading IVR menus...</span>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div className="space-y-1.5 flex-1 max-w-md">
                      <label className="font-bold text-slate-900 dark:text-slate-100 block">
                        Select IVR Menu
                      </label>
                      <select
                        value={selectedIvrMenuId}
                        onChange={(e) => setSelectedIvrMenuId(e.target.value)}
                        className="w-full px-3 py-2.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none text-xs font-semibold"
                      >
                        {ivrMenus.map((menu) => (
                          <option key={menu.id} value={menu.id}>
                            {menu.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="shrink-0 pt-2 sm:pt-5">
                      <Link
                        href="/settings/ivr"
                        className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline border border-blue-200 dark:border-blue-900/60 px-3 py-2 rounded-xl bg-white dark:bg-slate-900"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                        <span>Create / Edit Menu</span>
                      </Link>
                    </div>
                  </div>

                  {canManageNumbers && (
                    <div className="flex justify-end pt-2">
                      <Button
                        size="sm"
                        onClick={() => handleSaveIncomingStrategy('ivr')}
                        disabled={isSavingStrategy || !selectedIvrMenuId}
                        className="text-xs bg-blue-600 hover:bg-blue-700 text-white font-semibold"
                      >
                        {isSavingStrategy ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : null}
                        <span>Save Strategy</span>
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </Card>

      {/* 7. GREETINGS & AUDIO (SINGLE AUTHORITATIVE SECTION) */}
      <GreetingsAudioSettings phoneNumberId={numberId} />

      {/* 8. NUMBER LIFECYCLE (PORT OUT & RELEASE NUMBER) */}
      <NumberLifecycleSettings
        phoneNumberId={numberId}
        phoneNumberE164={phoneNumber.phone_number}
        friendlyName={phoneNumber.friendly_name}
      />
    </div>
  );
}
