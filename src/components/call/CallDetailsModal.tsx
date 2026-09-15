'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Avatar } from '@/components/ui/Avatar';
import {
  X,
  PhoneCall,
  UserCheck,
  UserX,
  UserPlus,
  Clock,
  CheckCircle2,
  PhoneIncoming,
  PhoneOutgoing,
  PhoneMissed,
  Ban,
  Shield,
  Loader2,
  AlertCircle,
} from 'lucide-react';
import { CallWithProfile } from '@/lib/repositories/call.repository';
import { formatDuration, formatCallTime, normalizeE164PhoneNumber } from '@/lib/utils';
import { useAuth } from '@/components/providers/AuthProvider';

interface CallDetailsModalProps {
  call: CallWithProfile | null;
  isOpen: boolean;
  onClose: () => void;
  onAssignmentUpdated?: () => void;
}

interface TeamMember {
  id: string;
  full_name: string;
  email: string;
  role: string;
  active?: boolean;
}

export function CallDetailsModal({
  call,
  isOpen,
  onClose,
  onAssignmentUpdated,
}: CallDetailsModalProps) {
  const { profile } = useAuth();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [isLoadingMembers, setIsLoadingMembers] = useState(false);

  // Assignment state
  const [isLoadingAssignment, setIsLoadingAssignment] = useState(false);
  const [assignedUser, setAssignedUser] = useState<TeamMember | null>(null);
  const [assignedUserId, setAssignedUserId] = useState<string | null>(null);
  const [isContact, setIsContact] = useState(false);
  const [assignmentSource, setAssignmentSource] = useState<string | null>(null);

  // Reassignment edit state
  const [isReassigning, setIsReassigning] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const isOutbound = call?.direction === 'outbound';
  const targetNumber = isOutbound ? call?.to_number || '' : call?.from_number || '';
  const normalizedTarget = normalizeE164PhoneNumber(targetNumber).normalized || targetNumber;

  const currentUserRole = profile?.role || 'agent';
  const currentUserId = profile?.id || '';

  // Permission evaluation for reassignment
  const isAdminOrManager = ['admin', 'manager'].includes(currentUserRole);
  const isSelfOwned = assignedUserId === currentUserId;
  const canReassign = isAdminOrManager || (currentUserRole === 'agent' && isSelfOwned);

  // Eligible members for assignment (Active Managers & Agents only, never Admins)
  const eligibleMembers = members.filter(
    (m) => m.active !== false && ['manager', 'agent'].includes(m.role)
  );

  const fetchAssignment = useCallback(async () => {
    if (!normalizedTarget) return;
    setIsLoadingAssignment(true);
    try {
      const res = await fetch(`/api/callers/assign?phoneNumber=${encodeURIComponent(normalizedTarget)}`);
      if (res.ok) {
        const data = await res.json();
        setAssignedUser(data.assignedUser || null);
        setAssignedUserId(data.assignedUserId || null);
        setSelectedAgentId(data.assignedUserId || '');
        setIsContact(Boolean(data.isContact));
        setAssignmentSource(data.source || null);
      }
    } catch (err) {
      console.error('Error fetching caller assignment:', err);
    } finally {
      setIsLoadingAssignment(false);
    }
  }, [normalizedTarget]);

  const fetchTeamMembers = useCallback(async () => {
    setIsLoadingMembers(true);
    try {
      const res = await fetch('/api/users/manage');
      if (res.ok) {
        const data = await res.json();
        setMembers(data.members || []);
      }
    } catch (err) {
      console.error('Error fetching workspace team members:', err);
    } finally {
      setIsLoadingMembers(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen && call) {
      fetchAssignment();
      fetchTeamMembers();
      setIsReassigning(false);
      setErrorMessage(null);
      setSuccessMessage(null);
    }
  }, [isOpen, call, fetchAssignment, fetchTeamMembers]);

  if (!isOpen || !call) return null;

  const handleSaveAssignment = async () => {
    setIsSaving(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const res = await fetch('/api/callers/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phoneNumber: normalizedTarget,
          assignedUserId: selectedAgentId ? selectedAgentId : null,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setErrorMessage(data.error || 'Failed to update caller assignment.');
        setIsSaving(false);
        return;
      }

      setSuccessMessage('Assigned Agent updated successfully.');
      setIsReassigning(false);
      await fetchAssignment();
      if (onAssignmentUpdated) {
        onAssignmentUpdated();
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Error updating assignment.');
    } finally {
      setIsSaving(false);
    }
  };

  const handledByAgentName = call.profiles?.full_name || 'Unassigned / Automated';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl max-w-lg w-full overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/40">
          <div className="flex items-center gap-3">
            <div
              className={`p-2.5 rounded-xl ${
                isOutbound
                  ? 'bg-blue-100 dark:bg-blue-950/80 text-blue-600 dark:text-blue-400'
                  : 'bg-emerald-100 dark:bg-emerald-950/80 text-emerald-600 dark:text-emerald-400'
              }`}
            >
              {isOutbound ? <PhoneOutgoing className="w-5 h-5" /> : <PhoneIncoming className="w-5 h-5" />}
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">Call & Lead Details</h2>
              <p className="text-xs font-mono text-slate-500 dark:text-slate-400">{normalizedTarget}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-5 overflow-y-auto">
          {errorMessage && (
            <div className="p-3 bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-800 rounded-xl text-xs text-rose-700 dark:text-rose-400 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}

          {successMessage && (
            <div className="p-3 bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-800 rounded-xl text-xs text-emerald-700 dark:text-emerald-400 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>{successMessage}</span>
            </div>
          )}

          {/* Call Summary Cards */}
          <div className="grid grid-cols-2 gap-3">
            <div className="p-3 bg-slate-50 dark:bg-slate-950/60 border border-slate-200/80 dark:border-slate-800/80 rounded-xl space-y-1">
              <span className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Direction</span>
              <p className="text-xs font-semibold text-slate-900 dark:text-slate-200 capitalize">{call.direction} Call</p>
            </div>
            <div className="p-3 bg-slate-50 dark:bg-slate-950/60 border border-slate-200/80 dark:border-slate-800/80 rounded-xl space-y-1">
              <span className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Status & Duration</span>
              <p className="text-xs font-semibold text-slate-900 dark:text-slate-200">
                {call.status.toUpperCase()} ({call.duration_seconds ? formatDuration(call.duration_seconds) : '00:00'})
              </p>
            </div>
          </div>

          {/* Explicit Separation: Handled By vs Assigned Agent */}
          <div className="space-y-4 pt-1">
            {/* 1. Handled By (Historical Call Owner) */}
            <div className="p-4 bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 rounded-xl space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">Handled By</span>
                <Badge variant="neutral" size="sm">Historical Call Owner</Badge>
              </div>
              <div className="flex items-center gap-3">
                <Avatar name={handledByAgentName} size="md" />
                <div>
                  <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">{handledByAgentName}</p>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    {call.answered_at ? `Answered call at ${formatCallTime(call.answered_at)}` : 'Call was not answered'}
                  </p>
                </div>
              </div>
            </div>

            {/* 2. Assigned Agent (Current Lead Owner) */}
            <div className="p-4 bg-blue-50/50 dark:bg-blue-950/20 border border-blue-200/80 dark:border-blue-900/40 rounded-xl space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-blue-900 dark:text-blue-300 flex items-center gap-1.5">
                  <UserCheck className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                  Assigned Agent
                </span>
                <div className="flex items-center gap-1.5">
                  {isContact ? (
                    <Badge variant="blue" size="sm">Saved Contact</Badge>
                  ) : assignmentSource ? (
                    <Badge variant="amber" size="sm">Unsaved Lead ({assignmentSource})</Badge>
                  ) : (
                    <Badge variant="neutral" size="sm">Unsaved Lead</Badge>
                  )}
                </div>
              </div>

              {isLoadingAssignment ? (
                <div className="flex items-center gap-2 text-xs text-slate-500 py-2">
                  <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
                  <span>Fetching caller assignment...</span>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Avatar name={assignedUser?.full_name || 'Unassigned'} size="md" />
                    <div>
                      <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                        {assignedUser ? assignedUser.full_name : 'Unassigned'}
                      </p>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400">
                        {assignedUser ? `Role: ${assignedUser.role.toUpperCase()}` : 'No preferred agent assigned'}
                      </p>
                    </div>
                  </div>

                  {!isReassigning && (
                    <Button
                      variant={canReassign ? 'outline' : 'ghost'}
                      size="sm"
                      disabled={!canReassign}
                      onClick={() => setIsReassigning(true)}
                      className="shrink-0"
                    >
                      <UserPlus className="w-3.5 h-3.5" />
                      <span>{assignedUser ? 'Reassign' : 'Assign'}</span>
                    </Button>
                  )}
                </div>
              )}

              {!canReassign && !isLoadingAssignment && (
                <p className="text-[11px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 p-2.5 rounded-lg border border-amber-200 dark:border-amber-900/60 leading-relaxed">
                  Agents can only reassign callers currently assigned to themselves.
                </p>
              )}

              {/* Reassignment Selector UI */}
              {isReassigning && (
                <div className="pt-3 border-t border-blue-200/60 dark:border-blue-900/40 space-y-3">
                  <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
                    Select Target Assigned Agent (Manager/Agent only):
                  </label>
                  <select
                    value={selectedAgentId}
                    onChange={(e) => setSelectedAgentId(e.target.value)}
                    className="w-full bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-800 rounded-xl text-xs p-2.5 text-slate-900 dark:text-slate-200 outline-none focus:border-blue-600 transition-colors"
                  >
                    <option value="">Unassigned (No Preferred Agent)</option>
                    {eligibleMembers.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.full_name} — {m.role === 'manager' ? 'Manager' : 'Agent'}{m.id === currentUserId ? ' (You)' : ''}
                      </option>
                    ))}
                  </select>

                  <div className="flex items-center justify-end gap-2 pt-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setIsReassigning(false)}
                      disabled={isSaving}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={handleSaveAssignment}
                      disabled={isSaving}
                    >
                      {isSaving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                      <span>Save Assignment</span>
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/40 flex justify-end">
          <Button variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
