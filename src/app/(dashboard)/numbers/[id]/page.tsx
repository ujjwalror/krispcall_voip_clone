'use client';

import React, { useEffect, useState, useCallback, use } from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import {
  ArrowLeft,
  Phone,
  PhoneCall,
  Sliders,
  Mic,
  MessageSquare,
  Volume2,
  Bell,
  Info,
  AlertTriangle,
  Loader2,
  RefreshCw,
  Shield,
  Star,
  Edit2,
  Check,
  X,
  Users,
  UserCheck,
  UserX,
  Copy,
  Lock,
  Globe,
  Radio,
  ChevronRight,
  ShieldCheck,
  AlertCircle,
} from 'lucide-react';
import { PhoneNumberItem } from '../page';
import { useAuth } from '@/components/providers/AuthProvider';

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
  greetingType?: string;
}

export default function NumberDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = use(params);
  const numberId = resolvedParams.id;
  const { profile } = useAuth();

  const [phoneNumber, setPhoneNumber] = useState<PhoneNumberItem | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Friendly Name Editing & Copy State
  const [isEditingFriendlyName, setIsEditingFriendlyName] = useState<boolean>(false);
  const [friendlyNameInput, setFriendlyNameInput] = useState<string>('');
  const [isSavingFriendlyName, setIsSavingFriendlyName] = useState<boolean>(false);
  const [copiedNumber, setCopiedNumber] = useState<boolean>(false);

  // Primary Line & Mutation State
  const [isSettingPrimary, setIsSettingPrimary] = useState<boolean>(false);
  const [mutationError, setMutationError] = useState<string | null>(null);

  // Shared Access / Assignment States
  const [assignmentMembers, setAssignmentMembers] = useState<AssignmentMember[]>([]);
  const [isAssignedToSelf, setIsAssignedToSelf] = useState<boolean>(false);
  const [isLoadingAssignments, setIsLoadingAssignments] = useState<boolean>(true);
  const [togglingUserIds, setTogglingUserIds] = useState<Record<string, boolean>>({});

  // Incoming Strategy & IVR Integration State
  const [strategyTab, setStrategyTab] = useState<'user' | 'forward' | 'ivr'>('user');
  const [isSavingStrategy, setIsSavingStrategy] = useState<boolean>(false);
  const [strategySuccessMsg, setStrategySuccessMsg] = useState<string | null>(null);

  // Forwarding UI Foundation State (Phase 19D.1 UI baseline, Phase 19D.3 Backend)
  const [forwardCountryCode, setForwardCountryCode] = useState<string>('+1');
  const [forwardDestinationNumber, setForwardDestinationNumber] = useState<string>('');
  const [forwardUnansweredSetting, setForwardUnansweredSetting] = useState<string>('hangup');

  // IVR Menu Integration State
  const [ivrMenus, setIvrMenus] = useState<IvrMenuOption[]>([]);
  const [isIvrEntitled, setIsIvrEntitled] = useState<boolean>(false);
  const [isLoadingIvrMenus, setIsLoadingIvrMenus] = useState<boolean>(false);
  const [selectedIvrMenuId, setSelectedIvrMenuId] = useState<string>('');

  const canManageNumbers = profile?.role === 'owner' || profile?.role === 'admin';

  // Fetch Phone Number Detail
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

  useEffect(() => {
    fetchNumberDetail();
    fetchAssignments();
    fetchIvrMenus();
  }, [fetchNumberDetail, fetchAssignments, fetchIvrMenus]);

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

  // Set Primary Business Number
  const handleSetPrimary = async () => {
    if (!phoneNumber) return;
    setIsSettingPrimary(true);
    setMutationError(null);
    try {
      const res = await fetch(`/api/phone-numbers/${numberId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isPrimary: true }),
      });

      const json = await res.json();
      if (res.ok && json.phoneNumber) {
        setPhoneNumber(json.phoneNumber);
      } else {
        setMutationError(json.message || 'Failed to set primary business number.');
      }
    } catch (err: any) {
      console.error('[NumberDetailPage] Set primary error:', err);
      setMutationError('Network error setting primary number.');
    } finally {
      setIsSettingPrimary(false);
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
              }
            : null
        );
        setStrategySuccessMsg(
          targetStrategy === 'user'
            ? 'Incoming strategy set to Web & Phone direct team routing.'
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
  const isNumberOperational = phoneNumber.active === true && phoneNumber.status === 'active';
  const assignedCount = assignmentMembers.filter((m) => m.is_assigned).length;

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
            <span className="font-semibold block mb-0.5">Management Error</span>
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

      {/* CARD 1 — NUMBER IDENTITY / HEADER */}
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
                      placeholder="e.g. Sales Enquiries, Customer Support"
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

          {/* Primary Line Designation & Capabilities */}
          <div className="flex flex-wrap items-center gap-3 shrink-0">
            {!phoneNumber.is_primary && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleSetPrimary}
                disabled={isSettingPrimary || !canManageNumbers || !isNumberOperational}
                title={
                  !canManageNumbers
                    ? 'Only workspace Owners and Admins can change primary number settings'
                    : !isNumberOperational
                    ? 'Only active operational numbers can be designated as primary'
                    : 'Designate as default workspace caller ID'
                }
                className="text-xs font-semibold"
              >
                {isSettingPrimary ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
                    <span>Setting...</span>
                  </>
                ) : (
                  <>
                    <Star className="w-3.5 h-3.5 text-amber-500 mr-1.5" />
                    <span>Set as Primary</span>
                  </>
                )}
              </Button>
            )}

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

      {/* CARD 2 — CALLER ID */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center justify-between">
            <span className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-emerald-500" />
              <span>Caller ID Configuration</span>
            </span>
            <span className="text-[10px] font-semibold text-slate-400">
              Provider Verified Outbound Line
            </span>
          </CardTitle>
        </CardHeader>
        <div className="p-4 space-y-4 text-xs">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950/60 border border-slate-200/60 dark:border-slate-800/60 space-y-1">
              <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider block">
                Outbound Line Authorization
              </span>
              <div className="flex items-center gap-2 pt-0.5">
                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
                  <Check className="w-3.5 h-3.5" />
                  Provider Authorized Line
                </span>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 pt-1 leading-relaxed">
                {phoneNumber.phone_number} is registered and valid for outbound calls originating from your workspace.
              </p>
            </div>

            <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950/60 border border-slate-200/60 dark:border-slate-800/60 space-y-1">
              <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider block">
                Workspace Outbound Default
              </span>
              <div className="flex items-center gap-2 pt-0.5">
                {phoneNumber.is_primary ? (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-bold bg-blue-500/15 text-blue-700 dark:text-blue-300">
                    <Star className="w-3.5 h-3.5 fill-current text-blue-500" />
                    Default Workspace Caller ID
                  </span>
                ) : (
                  <span className="text-xs text-slate-600 dark:text-slate-400 font-medium">
                    Secondary Line (Assignable to team members)
                  </span>
                )}
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 pt-1 leading-relaxed">
                {phoneNumber.is_primary
                  ? 'Default caller ID for workspace team members unless custom line assignment is active.'
                  : 'Assigned team members can select this number for outbound call caller ID.'}
              </p>
            </div>
          </div>

          {/* Anti-Spoofing Security Disclosure */}
          <div className="p-3.5 rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-900 dark:text-blue-200 flex items-start gap-3">
            <Lock className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
            <div className="text-[11px] leading-relaxed">
              <strong className="font-bold block mb-0.5">Anti-Spoofing Protection Active:</strong> Arbitrary unverified caller ID spoofing is strictly prohibited. Outbound calls verify provider authorization and organization line ownership before dispatch.
            </div>
          </div>
        </div>
      </Card>

      {/* CARD 3 — SHARED ACCESS & TEAM MEMBER ASSIGNMENTS */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center justify-between">
            <span className="flex items-center gap-2">
              <Users className="w-4 h-4 text-blue-500" />
              <span>Shared Access & Team Member Assignments</span>
            </span>
            <span className="text-[10px] font-semibold text-slate-400">
              {canManageNumbers ? 'Owner / Admin Control' : 'Read-Only Access'}
            </span>
          </CardTitle>
        </CardHeader>
        <div className="p-4 space-y-4">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Choose which active team members in your organization can use this business number for outbound caller ID and receive inbound calls.
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

      {/* CARD 4 — INCOMING CALL STRATEGY */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center justify-between">
            <span className="flex items-center gap-2">
              <PhoneCall className="w-4 h-4 text-emerald-500" />
              <span>Incoming Call Strategy</span>
            </span>
            <span className="text-[10px] font-semibold text-slate-400">
              Only 1 Entry Strategy Active
            </span>
          </CardTitle>
        </CardHeader>
        <div className="p-4 space-y-5">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Configure how incoming phone calls to <strong className="text-slate-800 dark:text-slate-200 font-mono">{phoneNumber.phone_number}</strong> should be answered.
          </p>

          {/* Accessible 3-Way Segmented Radio Cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {/* OPTION A: Web & Phone */}
            <button
              type="button"
              onClick={() => setStrategyTab('user')}
              className={`p-4 rounded-xl text-left border transition-all flex flex-col justify-between space-y-3 relative ${
                strategyTab === 'user'
                  ? 'bg-blue-50/80 dark:bg-blue-950/60 border-blue-500 ring-2 ring-blue-500/30'
                  : 'bg-slate-50 dark:bg-slate-900/60 border-slate-200 dark:border-slate-800 hover:border-slate-300'
              }`}
            >
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2">
                  <Phone className={`w-4 h-4 ${strategyTab === 'user' ? 'text-blue-600 dark:text-blue-400' : 'text-slate-400'}`} />
                  <span className="font-bold text-xs text-slate-900 dark:text-slate-100">
                    A. Web & Phone
                  </span>
                </div>
                {phoneNumber.inbound_routing_type === 'user' && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30">
                    Active
                  </span>
                )}
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-snug">
                Route incoming calls directly to assigned workspace team members via WebRTC apps.
              </p>
            </button>

            {/* OPTION B: Forward Calls (Phase 19D.1 UI baseline) */}
            <button
              type="button"
              onClick={() => setStrategyTab('forward')}
              className={`p-4 rounded-xl text-left border transition-all flex flex-col justify-between space-y-3 relative ${
                strategyTab === 'forward'
                  ? 'bg-blue-50/80 dark:bg-blue-950/60 border-blue-500 ring-2 ring-blue-500/30'
                  : 'bg-slate-50 dark:bg-slate-900/60 border-slate-200 dark:border-slate-800 hover:border-slate-300'
              }`}
            >
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2">
                  <Globe className={`w-4 h-4 ${strategyTab === 'forward' ? 'text-blue-600 dark:text-blue-400' : 'text-slate-400'}`} />
                  <span className="font-bold text-xs text-slate-900 dark:text-slate-100">
                    B. Forward Calls
                  </span>
                </div>
                <span className="px-2 py-0.5 rounded-full text-[9px] font-bold bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30">
                  Unavailable (19D.3)
                </span>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-snug">
                Forward incoming calls to an external PSTN destination phone number.
              </p>
            </button>

            {/* OPTION C: Call Menu (IVR) */}
            <button
              type="button"
              onClick={() => setStrategyTab('ivr')}
              className={`p-4 rounded-xl text-left border transition-all flex flex-col justify-between space-y-3 relative ${
                strategyTab === 'ivr'
                  ? 'bg-blue-50/80 dark:bg-blue-950/60 border-blue-500 ring-2 ring-blue-500/30'
                  : 'bg-slate-50 dark:bg-slate-900/60 border-slate-200 dark:border-slate-800 hover:border-slate-300'
              }`}
            >
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2">
                  <Shield className={`w-4 h-4 ${strategyTab === 'ivr' ? 'text-blue-600 dark:text-blue-400' : 'text-slate-400'}`} />
                  <span className="font-bold text-xs text-slate-900 dark:text-slate-100">
                    C. Call Menu (IVR)
                  </span>
                </div>
                {phoneNumber.inbound_routing_type === 'ivr' && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30">
                    Active
                  </span>
                )}
                {!isIvrEntitled && (
                  <span className="px-2 py-0.5 rounded-full text-[9px] font-bold bg-slate-200 dark:bg-slate-800 text-slate-500">
                    Pro Only
                  </span>
                )}
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-snug">
                Play an automated greeting with keypad options (Press 1 for Sales, Press 2 for Support).
              </p>
            </button>
          </div>

          {/* ACTIVE STRATEGY DETAILS PANEL */}

          {/* OPTION A DETAILS PANEL */}
          {strategyTab === 'user' && (
            <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-xs font-bold text-slate-900 dark:text-slate-100">
                    Option A — Web & Phone Direct Routing
                  </h4>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                    Direct incoming call distribution to assigned active team members in this workspace.
                  </p>
                </div>
                {phoneNumber.inbound_routing_type !== 'user' && canManageNumbers && (
                  <Button
                    size="sm"
                    onClick={() => handleSaveIncomingStrategy('user')}
                    disabled={isSavingStrategy}
                    className="text-xs bg-blue-600 hover:bg-blue-700 text-white font-semibold"
                  >
                    {isSavingStrategy ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : null}
                    <span>Activate Web & Phone</span>
                  </Button>
                )}
              </div>

              {/* Eligible Assigned Users Summary */}
              <div className="p-3 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-2 text-xs">
                <span className="font-semibold text-slate-700 dark:text-slate-300 block">
                  Eligible Assigned Workspace Members ({assignedCount})
                </span>
                {assignedCount === 0 ? (
                  <p className="text-[11px] text-amber-600 dark:text-amber-400">
                    No team members are currently assigned to this number. Assign members in Card 3 above to receive incoming calls.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {assignmentMembers
                      .filter((m) => m.is_assigned)
                      .map((m) => (
                        <span
                          key={m.id}
                          className="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-[11px] font-semibold text-slate-800 dark:text-slate-200 border border-slate-200 dark:border-slate-700 flex items-center gap-1.5"
                        >
                          <UserCheck className="w-3 h-3 text-emerald-500" />
                          <span>{m.full_name}</span>
                        </span>
                      ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* OPTION B DETAILS PANEL (FORWARDING FOUNDATION) */}
          {strategyTab === 'forward' && (
            <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60 space-y-4">
              <div className="flex items-center justify-between border-b border-slate-200/60 dark:border-slate-800/60 pb-3">
                <div>
                  <h4 className="text-xs font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                    <span>Option B — External Call Forwarding</span>
                    <span className="px-2 py-0.5 rounded-md bg-amber-500/15 text-amber-700 dark:text-amber-300 text-[10px] font-extrabold border border-amber-500/30">
                      Unavailable — Phase 19D.3 Backend
                    </span>
                  </h4>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                    Forward incoming calls to an external landline or mobile telephone number.
                  </p>
                </div>
              </div>

              {/* Forwarding Form Foundation Controls */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                {/* Country Code Select */}
                <div className="space-y-1">
                  <label className="font-semibold text-slate-700 dark:text-slate-300 block">
                    Country Code
                  </label>
                  <select
                    value={forwardCountryCode}
                    onChange={(e) => setForwardCountryCode(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none text-xs font-medium"
                  >
                    <option value="+1">United States / Canada (+1)</option>
                    <option value="+44">United Kingdom (+44)</option>
                    <option value="+61">Australia (+61)</option>
                    <option value="+91">India (+91)</option>
                  </select>
                </div>

                {/* Destination Phone Number */}
                <div className="space-y-1">
                  <label className="font-semibold text-slate-700 dark:text-slate-300 block">
                    Destination Phone Number
                  </label>
                  <input
                    type="tel"
                    value={forwardDestinationNumber}
                    onChange={(e) => setForwardDestinationNumber(e.target.value)}
                    placeholder="e.g. +15551234567"
                    className="w-full px-3 py-2 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none text-xs font-mono font-medium"
                  />
                </div>

                {/* Unanswered Call Setting (Requirement 6: Voicemail pipeline incomplete, show supported options) */}
                <div className="space-y-1 sm:col-span-2">
                  <label className="font-semibold text-slate-700 dark:text-slate-300 block">
                    Unanswered Call Behaviour
                  </label>
                  <select
                    value={forwardUnansweredSetting}
                    onChange={(e) => setForwardUnansweredSetting(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none text-xs font-medium"
                  >
                    <option value="hangup">Hang Up Call</option>
                    <option value="fallback_user">Fallback to Web & Phone Team Apps</option>
                  </select>
                </div>
              </div>

              {/* Call Charge Notice */}
              <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-900 dark:text-amber-200 text-[11px] space-y-1">
                <strong className="font-bold block">Financial & Billing Notice:</strong>
                <p>
                  Call forwarding incurs standard outbound per-minute call rates based on provider PSTN destination rates. External forwarding route execution requires Phase 19D.3 secure backend logic.
                </p>
              </div>

              {/* Disabled Action Button with Clear Badge */}
              <div className="pt-2 flex justify-end">
                <Button
                  disabled
                  className="text-xs bg-slate-300 dark:bg-slate-800 text-slate-500 dark:text-slate-400 font-semibold cursor-not-allowed border border-slate-200 dark:border-slate-700"
                >
                  <span>Forwarding Unavailable (Phase 19D.3)</span>
                </Button>
              </div>
            </div>
          )}

          {/* OPTION C DETAILS PANEL (IVR CALL MENU) */}
          {strategyTab === 'ivr' && (
            <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60 space-y-4">
              <div className="flex items-center justify-between border-b border-slate-200/60 dark:border-slate-800/60 pb-3">
                <div>
                  <h4 className="text-xs font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                    <span>Option C — Call Menu (IVR / Auto-Attendant)</span>
                  </h4>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                    Connect incoming calls to an interactive voice response menu.
                  </p>
                </div>
              </div>

              {/* Entitlement Check Gate */}
              {!isIvrEntitled ? (
                <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/60 space-y-2">
                  <div className="flex items-center gap-2 text-amber-800 dark:text-amber-200 text-xs font-bold">
                    <Lock className="w-4 h-4 text-amber-500" />
                    <span>Plan Entitlement Restricted</span>
                  </div>
                  <p className="text-[11px] text-amber-700 dark:text-amber-300 leading-relaxed">
                    Call Menu (IVR) feature is available exclusively on the <strong>Pro</strong> subscription plan. (Starter and Business plans do not include IVR auto-attendant entitlements). Upgrade to Pro to enable custom IVR menus.
                  </p>
                </div>
              ) : isLoadingIvrMenus ? (
                <div className="flex items-center justify-center py-6 space-y-2">
                  <Loader2 className="w-5 h-5 text-blue-500 animate-spin" />
                  <span className="text-xs text-slate-400 ml-2">Loading IVR menus...</span>
                </div>
              ) : ivrMenus.length === 0 ? (
                <div className="p-4 rounded-xl bg-slate-100 dark:bg-slate-900 text-center space-y-2">
                  <p className="text-xs text-slate-500 font-medium">No active IVR Call Menus found for your workspace.</p>
                  <Link
                    href="/settings/ivr"
                    className="inline-flex items-center gap-1.5 text-xs font-bold text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    <span>Create IVR Menu in Settings &rarr;</span>
                  </Link>
                </div>
              ) : (
                <div className="space-y-4 text-xs">
                  <div className="space-y-1">
                    <label className="font-semibold text-slate-700 dark:text-slate-300 block">
                      Select IVR Call Menu
                    </label>
                    <select
                      value={selectedIvrMenuId}
                      onChange={(e) => setSelectedIvrMenuId(e.target.value)}
                      className="w-full px-3 py-2.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none text-xs font-semibold"
                    >
                      {ivrMenus.map((menu) => (
                        <option key={menu.id} value={menu.id}>
                          {menu.name} ({menu.enabled ? 'Enabled' : 'Disabled'})
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Save Button for Option C */}
                  {canManageNumbers && (
                    <div className="flex justify-end pt-2">
                      <Button
                        size="sm"
                        onClick={() => handleSaveIncomingStrategy('ivr')}
                        disabled={isSavingStrategy || !selectedIvrMenuId}
                        className="text-xs bg-blue-600 hover:bg-blue-700 text-white font-semibold"
                      >
                        {isSavingStrategy ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : null}
                        <span>Save Call Menu Strategy</span>
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </Card>

      {/* CARD 5 — ADDITIONAL NUMBER SETTINGS & LIFECYCLE */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center justify-between">
            <span className="flex items-center gap-2">
              <Sliders className="w-4 h-4 text-purple-500" />
              <span>Additional Settings & Lifecycle</span>
            </span>
            <span className="text-[10px] font-semibold text-slate-400">Workspace Controls</span>
          </CardTitle>
        </CardHeader>
        <div className="p-4 space-y-3 text-xs">
          <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60 flex items-center justify-between">
            <div>
              <span className="font-semibold text-slate-800 dark:text-slate-200 block">Greetings & Audio</span>
              <span className="text-[11px] text-slate-500">Welcome greeting and hold audio selection</span>
            </div>
            <span className="font-semibold text-slate-500">Default</span>
          </div>

          <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60 flex items-center justify-between">
            <div>
              <span className="font-semibold text-slate-800 dark:text-slate-200 block">Notifications</span>
              <span className="text-[11px] text-slate-500">Missed call and event alert notifications</span>
            </div>
            <span className="font-semibold text-slate-500">Workspace Admins</span>
          </div>

          <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60 flex items-center justify-between">
            <div>
              <span className="font-semibold text-slate-800 dark:text-slate-200 block">Port Out Number</span>
              <span className="text-[11px] text-slate-500">Request carrier porting instructions for this line</span>
            </div>
            <Link
              href={`/api/phone-numbers/${numberId}/port-out`}
              className="text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline"
            >
              Request Instructions &rarr;
            </Link>
          </div>

          <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60 flex items-center justify-between">
            <div>
              <span className="font-semibold text-slate-800 dark:text-slate-200 block">Voluntary Release</span>
              <span className="text-[11px] text-slate-500">Voluntarily relinquish ownership of this phone line</span>
            </div>
            <Link
              href={`/billing/numbers`}
              className="text-xs font-semibold text-rose-600 dark:text-rose-400 hover:underline"
            >
              Voluntary Release &rarr;
            </Link>
          </div>
        </div>
      </Card>
    </div>
  );
}
