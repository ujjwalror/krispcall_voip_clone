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

export default function NumberDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = use(params);
  const numberId = resolvedParams.id;
  const { profile } = useAuth();

  const [phoneNumber, setPhoneNumber] = useState<PhoneNumberItem | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Phase 7.3 Mutation States
  const [isEditingFriendlyName, setIsEditingFriendlyName] = useState<boolean>(false);
  const [friendlyNameInput, setFriendlyNameInput] = useState<string>('');
  const [isSavingFriendlyName, setIsSavingFriendlyName] = useState<boolean>(false);

  const [isSettingPrimary, setIsSettingPrimary] = useState<boolean>(false);
  const [mutationError, setMutationError] = useState<string | null>(null);

  // Phase 7.4 Assignment States
  const [assignmentMembers, setAssignmentMembers] = useState<AssignmentMember[]>([]);
  const [isAssignedToSelf, setIsAssignedToSelf] = useState<boolean>(false);
  const [isLoadingAssignments, setIsLoadingAssignments] = useState<boolean>(true);
  const [togglingUserIds, setTogglingUserIds] = useState<Record<string, boolean>>({});

  const canManageNumbers = profile?.role === 'owner' || profile?.role === 'admin';

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

  useEffect(() => {
    fetchNumberDetail();
    fetchAssignments();
  }, [fetchNumberDetail, fetchAssignments]);

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
      setTogglingUserIds((prev) => ({ ...prev, [targetUserId]: false }));
    }
  };

  // Handle Edit Friendly Name Submit
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

  // Handle Atomic Set Primary Number Submit
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

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 space-y-4 max-w-4xl mx-auto">
        <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
        <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">
          Loading phone number configuration...
        </p>
      </div>
    );
  }

  if (error || !phoneNumber) {
    return (
      <div className="max-w-4xl mx-auto space-y-6">
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

  return (
    <div className="space-y-6 max-w-5xl mx-auto pb-16">
      {/* Top Back Navigation */}
      <div>
        <Link
          href="/numbers"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline mb-2"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to My Numbers</span>
        </Link>
      </div>

      {/* Mutation Error Alert Banner */}
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

      {/* Main Header & Real Number Facts */}
      <Card className="border-slate-200 dark:border-slate-800 bg-gradient-to-br from-white via-slate-50/50 to-blue-50/20 dark:from-slate-900 dark:via-slate-900/95 dark:to-blue-950/20">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-6">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-xl bg-blue-600/15 text-blue-600 dark:text-blue-400 flex items-center justify-center font-mono font-bold text-base border border-blue-500/20 shrink-0">
              <Phone className="w-6 h-6" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-mono font-bold text-slate-900 dark:text-slate-100">
                  {phoneNumber.phone_number}
                </h1>
                {phoneNumber.is_primary && (
                  <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-blue-500/15 text-blue-700 dark:text-blue-300 border border-blue-500/30 flex items-center gap-1">
                    <Star className="w-3 h-3 fill-current text-blue-500" />
                    <span>Primary Line</span>
                  </span>
                )}
                <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 capitalize">
                  {phoneNumber.active ? 'Active' : 'Inactive'}
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                {phoneNumber.friendly_name || 'Business number'}
              </p>
            </div>
          </div>

          {/* Primary Action & Capabilities */}
          <div className="flex flex-wrap items-center gap-3 shrink-0">
            {/* Set Primary Button */}
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

            {/* Capability Badges */}
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

      {/* Concept Architecture Notice */}
      <div className="p-4 rounded-xl bg-blue-500/10 border border-blue-500/20 text-xs text-blue-900 dark:text-blue-200 flex items-start gap-3">
        <Info className="w-5 h-5 text-blue-500 shrink-0 mt-0.5" />
        <div>
          <strong className="font-bold">Number Configuration Architecture:</strong> Management operations in Phase 7.3 (editing friendly name, primary designation) update workspace business number settings locally without making external provider changes.
        </div>
      </div>

      {/* GRID OF CONFIGURATION SECTIONS */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* A. GENERAL IDENTIFICATION */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Sliders className="w-4 h-4 text-blue-500" />
                <span>General & Identification</span>
              </span>
              {!canManageNumbers && (
                <span className="text-[10px] font-semibold text-slate-400">Read-only (Agent/Manager)</span>
              )}
            </CardTitle>
          </CardHeader>
          <div className="space-y-3 text-xs">
            {/* Friendly Name Editable Row */}
            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60 flex items-center justify-between">
              <span className="text-slate-500 font-medium">Friendly Name</span>
              {isEditingFriendlyName ? (
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    maxLength={100}
                    value={friendlyNameInput}
                    onChange={(e) => setFriendlyNameInput(e.target.value)}
                    placeholder="e.g. Sales Support Line"
                    className="px-2 py-1 rounded-lg text-xs font-semibold bg-white dark:bg-slate-900 border border-blue-500 text-slate-900 dark:text-slate-100 focus:outline-none w-44 sm:w-56"
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
                  <span className="font-semibold text-slate-900 dark:text-slate-100">
                    {phoneNumber.friendly_name || 'Business number'}
                  </span>
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
            </div>

            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60 flex items-center justify-between">
              <span className="text-slate-500">Caller ID</span>
              <span className="font-semibold text-slate-900 dark:text-slate-100">Enabled</span>
            </div>
            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60 flex items-center justify-between">
              <span className="text-slate-500">Caller ID</span>
              <span className="font-semibold text-slate-900 dark:text-slate-100">Enabled</span>
            </div>
          </div>
        </Card>

        {/* SHARE ACCESS & TEAM MEMBER ASSIGNMENTS */}
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="text-sm flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Users className="w-4 h-4 text-blue-500" />
                <span>Share Access & Team Member Assignments</span>
              </span>
              <span className="text-[10px] font-semibold text-slate-400">
                {canManageNumbers ? 'Owner / Admin Control' : 'Read-Only Access'}
              </span>
            </CardTitle>
          </CardHeader>
          <div className="p-4 space-y-4">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Choose which active team members can use this business number for outbound caller ID.
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

        {/* B. CALL HANDLING & ROUTING */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center justify-between">
              <span className="flex items-center gap-2">
                <PhoneCall className="w-4 h-4 text-emerald-500" />
                <span>Call Handling & Strategy</span>
              </span>
              <span className="text-[10px] font-semibold text-slate-400">Read-only</span>
            </CardTitle>
          </CardHeader>
          <div className="space-y-3 text-xs">
            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60 flex items-center justify-between">
              <span className="text-slate-500">Incoming Call Strategy</span>
              <span className="font-semibold text-slate-900 dark:text-slate-100">Default WebRTC</span>
            </div>
            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60 flex items-center justify-between">
              <span className="text-slate-500">Call Forwarding</span>
              <span className="font-medium text-slate-400">Not configured</span>
            </div>
            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60 flex items-center justify-between">
              <span className="text-slate-500">Unanswered Call Behaviour</span>
              <span className="font-semibold text-slate-900 dark:text-slate-100">Workspace Voicemail</span>
            </div>
          </div>
        </Card>

        {/* C. IVR & CALL FLOW */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Shield className="w-4 h-4 text-indigo-500" />
                <span>IVR & Call Flow Builder</span>
              </span>
              <span className="text-[10px] font-semibold text-slate-400">Read-only</span>
            </CardTitle>
          </CardHeader>
          <div className="space-y-3 text-xs">
            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60 flex items-center justify-between">
              <span className="text-slate-500">IVR Tree / Auto-Attendant</span>
              <span className="font-medium text-slate-400">Not configured</span>
            </div>
            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60 flex items-center justify-between">
              <span className="text-slate-500">Extension Routing</span>
              <span className="font-medium text-slate-400">Not configured</span>
            </div>
          </div>
        </Card>

        {/* D & E. RECORDING & TRANSCRIPTION */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Mic className="w-4 h-4 text-amber-500" />
                <span>Recording & Transcription</span>
              </span>
              <span className="text-[10px] font-semibold text-slate-400">Read-only</span>
            </CardTitle>
          </CardHeader>
          <div className="space-y-3 text-xs">
            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60 flex items-center justify-between">
              <span className="text-slate-500">Automatic Call Recording</span>
              <span className="font-semibold text-slate-900 dark:text-slate-100">Workspace Default</span>
            </div>
            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60 flex items-center justify-between">
              <span className="text-slate-500">Voicemail Transcription</span>
              <span className="font-medium text-slate-400">Not configured</span>
            </div>
            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60 flex items-center justify-between">
              <span className="text-slate-500">AI Call Transcription</span>
              <span className="font-medium text-slate-400">Not configured</span>
            </div>
          </div>
        </Card>

        {/* F. MESSAGING & AUTO-REPLIES */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-sm flex items-center justify-between">
              <span className="flex items-center gap-2">
                <MessageSquare className="w-4 h-4 text-purple-500" />
                <span>SMS Messaging & Auto-Replies</span>
              </span>
              <span className="text-[10px] font-semibold text-slate-400">Read-only</span>
            </CardTitle>
          </CardHeader>
          <div className="space-y-3 text-xs">
            {!phoneNumber.capabilities_sms ? (
              <div className="p-3.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-800 dark:text-amber-200 text-xs">
                <strong>SMS Capability Not Registered:</strong> Carrier SMS registration is required for this number before SMS forwarding and missed-call auto replies can be configured.
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60 flex items-center justify-between">
                  <span className="text-slate-500">SMS Forwarding</span>
                  <span className="font-medium text-slate-400">Not configured</span>
                </div>
                <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60 flex items-center justify-between">
                  <span className="text-slate-500">Missed Call Auto Reply</span>
                  <span className="font-medium text-slate-400">Not configured</span>
                </div>
              </div>
            )}
          </div>
        </Card>

        {/* G. GREETINGS & AUDIO */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Volume2 className="w-4 h-4 text-cyan-500" />
                <span>Greetings & Audio Files</span>
              </span>
              <span className="text-[10px] font-semibold text-slate-400">Read-only</span>
            </CardTitle>
          </CardHeader>
          <div className="space-y-3 text-xs">
            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60 flex items-center justify-between">
              <span className="text-slate-500">Welcome Greeting</span>
              <span className="font-semibold text-slate-900 dark:text-slate-100">Default</span>
            </div>
            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60 flex items-center justify-between">
              <span className="text-slate-500">Voicemail Greeting</span>
              <span className="font-semibold text-slate-900 dark:text-slate-100">Default</span>
            </div>
            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60 flex items-center justify-between">
              <span className="text-slate-500">Hold Audio & Music</span>
              <span className="font-semibold text-slate-900 dark:text-slate-100">Default</span>
            </div>
          </div>
        </Card>

        {/* H & I. NOTIFICATIONS & NUMBER LIFECYCLE */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Bell className="w-4 h-4 text-rose-500" />
                <span>Lifecycle & Permissions</span>
              </span>
              <span className="text-[10px] font-semibold text-slate-400">Read-only</span>
            </CardTitle>
          </CardHeader>
          <div className="space-y-3 text-xs">
            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60 flex items-center justify-between">
              <span className="text-slate-500">Email Notifications</span>
              <span className="font-semibold text-slate-900 dark:text-slate-100">Workspace Admins</span>
            </div>
            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60 flex items-center justify-between">
              <span className="text-slate-500">Port Out Number</span>
              <span className="text-[11px] font-semibold text-slate-400">Upcoming</span>
            </div>
            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60 flex items-center justify-between">
              <span className="text-slate-500">Release Number</span>
              <span className="text-[11px] font-semibold text-slate-400">Upcoming</span>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
