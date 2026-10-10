'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import {
  Users,
  UserCheck,
  UserX,
  Plus,
  Search,
  X,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Mail,
  ShieldCheck,
  AlertTriangle,
} from 'lucide-react';

export interface AssignedMember {
  id: string;
  full_name: string;
  email: string;
  role: string;
  active: boolean;
  avatar_url?: string | null;
  is_assigned: boolean;
}

export interface SeatMetrics {
  usedOrReservedSeats: number;
  activeMembers: number;
  pendingInvitations: number;
  maxActiveUsersLimit: number | null;
  canAddMoreSeats: boolean;
}

interface SharedAccessSettingsProps {
  numberId: string;
  isOperational: boolean;
  canManageNumbers: boolean;
}

export function SharedAccessSettings({
  numberId,
  isOperational,
  canManageNumbers,
}: SharedAccessSettingsProps) {
  const [assignedMembers, setAssignedMembers] = useState<AssignedMember[]>([]);
  const [unassignedMembers, setUnassignedMembers] = useState<AssignedMember[]>([]);
  const [isAssignedToSelf, setIsAssignedToSelf] = useState<boolean>(false);
  const [seatMetrics, setSeatMetrics] = useState<SeatMetrics | null>(null);

  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Modal State
  const [isPickerOpen, setIsPickerOpen] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [isSavingAssignments, setIsSavingAssignments] = useState<boolean>(false);
  const [modalFeedback, setModalFeedback] = useState<{
    type: 'success' | 'error' | 'warning';
    message: string;
  } | null>(null);

  // Removing state
  const [removingUserId, setRemovingUserId] = useState<string | null>(null);

  // Inviting Non-Member state
  const [isSendingInvite, setIsSendingInvite] = useState<boolean>(false);

  // Fetch access list from server
  const fetchAccessData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/phone-numbers/${numberId}/assignments`);
      if (res.ok) {
        const data = await res.json();
        if (canManageNumbers) {
          setAssignedMembers(data.assignedMembers || []);
          setUnassignedMembers(data.unassignedMembers || []);
          if (data.seatMetrics) {
            setSeatMetrics(data.seatMetrics);
          }
        } else {
          setIsAssignedToSelf(Boolean(data.isAssigned));
        }
      } else {
        const errJson = await res.json().catch(() => ({}));
        setError(errJson.message || 'Failed to load number access data.');
      }
    } catch (err) {
      console.error('[SharedAccessSettings] Error fetching access:', err);
      setError('Network error loading access list.');
    } finally {
      setIsLoading(false);
    }
  }, [numberId, canManageNumbers]);

  useEffect(() => {
    fetchAccessData();
  }, [fetchAccessData]);

  // Handle removing a member's access
  const handleRemoveAccess = async (userId: string) => {
    if (!canManageNumbers || !isOperational) return;
    setRemovingUserId(userId);
    setError(null);

    try {
      const res = await fetch(`/api/phone-numbers/${numberId}/assignments`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });

      if (res.ok) {
        await fetchAccessData();
      } else {
        const errJson = await res.json().catch(() => ({}));
        setError(errJson.message || 'Failed to remove member access.');
      }
    } catch (err) {
      console.error('[SharedAccessSettings] Error removing access:', err);
      setError('Network error removing member access.');
    } finally {
      setRemovingUserId(null);
    }
  };

  // Open Add User picker modal
  const handleOpenPicker = () => {
    setSearchQuery('');
    setSelectedUserIds([]);
    setModalFeedback(null);
    setIsPickerOpen(true);
  };

  // Toggle user selection in modal picker
  const handleToggleSelectUser = (userId: string) => {
    setSelectedUserIds((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]
    );
  };

  // Confirm batch assignment of selected existing members
  const handleAddSelectedToNumber = async () => {
    if (selectedUserIds.length === 0) return;
    setIsSavingAssignments(true);
    setModalFeedback(null);

    try {
      const res = await fetch(`/api/phone-numbers/${numberId}/assignments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userIds: selectedUserIds }),
      });

      if (res.ok) {
        await fetchAccessData();
        setIsPickerOpen(false);
      } else {
        const errJson = await res.json().catch(() => ({}));
        setModalFeedback({
          type: 'error',
          message: errJson.message || 'Failed to assign selected members to number.',
        });
      }
    } catch (err) {
      console.error('[SharedAccessSettings] Error saving assignments:', err);
      setModalFeedback({
        type: 'error',
        message: 'Network error saving member assignments.',
      });
    } finally {
      setIsSavingAssignments(false);
    }
  };

  // Handle inviting a non-workspace member by email
  const handleInviteNonMember = async (emailToInvite: string) => {
    const email = emailToInvite.trim().toLowerCase();
    if (!email || !email.includes('@')) {
      setModalFeedback({
        type: 'error',
        message: 'Please enter a valid email address.',
      });
      return;
    }

    setIsSendingInvite(true);
    setModalFeedback(null);

    try {
      const res = await fetch('/api/invitations/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          role: 'agent',
          intended_phone_number_id: numberId,
        }),
      });

      const json = await res.json();

      if (res.ok && json.success) {
        setModalFeedback({
          type: 'success',
          message: `Invitation sent to ${email}. They will be assigned to this number upon joining.`,
        });
        setSearchQuery('');
        await fetchAccessData();
      } else {
        if (json.code === 'seat_limit_exceeded') {
          setModalFeedback({
            type: 'warning',
            message:
              json.error ||
              'Your workspace has reached its member limit. Remove an unused member or upgrade your plan to invite another person.',
          });
        } else {
          setModalFeedback({
            type: 'error',
            message: json.error || 'Failed to send workspace invitation.',
          });
        }
      }
    } catch (err) {
      console.error('[SharedAccessSettings] Error inviting non-member:', err);
      setModalFeedback({
        type: 'error',
        message: 'Network error sending invitation.',
      });
    } finally {
      setIsSendingInvite(false);
    }
  };

  // Filter unassigned candidates by search query
  const filteredCandidates = unassignedMembers.filter((m) => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return true;
    return m.full_name?.toLowerCase().includes(q) || m.email?.toLowerCase().includes(q);
  });

  // Check if typed query looks like an un-matched external email
  const cleanSearchQuery = searchQuery.trim().toLowerCase();
  const isEmailQuery = cleanSearchQuery.includes('@') && cleanSearchQuery.length >= 5;
  const isExactWorkspaceMemberMatch =
    assignedMembers.some((m) => m.email?.toLowerCase() === cleanSearchQuery) ||
    unassignedMembers.some((m) => m.email?.toLowerCase() === cleanSearchQuery);

  const showInviteOption = isEmailQuery && !isExactWorkspaceMemberMatch;

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <CardTitle className="text-base font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <Users className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            <span>Shared Access</span>
          </CardTitle>
          {canManageNumbers && (
            <Button
              size="sm"
              variant="primary"
              disabled={!isOperational || isLoading}
              onClick={handleOpenPicker}
              className="text-xs px-3 h-8 gap-1.5 font-semibold shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              Add User
            </Button>
          )}
        </CardHeader>

        <div className="p-4 space-y-4">
          {error && (
            <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {isLoading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="w-5 h-5 text-blue-500 animate-spin" />
              <span className="text-xs text-slate-400 ml-2">Loading member access...</span>
            </div>
          ) : canManageNumbers ? (
            assignedMembers.length === 0 ? (
              <div className="p-6 text-center border border-dashed border-slate-200 dark:border-slate-800 rounded-xl">
                <UserX className="w-8 h-8 text-slate-300 dark:text-slate-600 mx-auto mb-2" />
                <p className="text-xs font-medium text-slate-600 dark:text-slate-400">
                  No members are assigned to this phone number yet.
                </p>
                <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5 mb-3">
                  Click "+ Add User" above to grant workspace members access.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!isOperational}
                  onClick={handleOpenPicker}
                  className="text-xs h-8 gap-1"
                >
                  <Plus className="w-3.5 h-3.5" /> Add User
                </Button>
              </div>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200/80 dark:border-slate-800/80 rounded-xl overflow-hidden bg-white dark:bg-slate-900/40">
                {assignedMembers.map((member) => {
                  const isRemoving = removingUserId === member.id;
                  return (
                    <div
                      key={member.id}
                      className="p-3.5 flex items-center justify-between gap-4 hover:bg-slate-50/60 dark:hover:bg-slate-800/30 transition-colors"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-9 h-9 rounded-full bg-blue-100 dark:bg-blue-950/60 border border-blue-200 dark:border-blue-800 flex items-center justify-center text-blue-700 dark:text-blue-300 font-bold text-xs shrink-0">
                          {member.full_name?.charAt(0).toUpperCase() || 'U'}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
                              {member.full_name}
                            </span>
                            <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 capitalize">
                              {member.role}
                            </span>
                          </div>
                          <span className="text-[11px] text-slate-500 dark:text-slate-400 truncate block">
                            {member.email}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-3 shrink-0">
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 px-2.5 py-1 rounded-full border border-emerald-200 dark:border-emerald-800/60">
                          <UserCheck className="w-3.5 h-3.5" />
                          Assigned
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={isRemoving || !isOperational}
                          onClick={() => handleRemoveAccess(member.id)}
                          className="text-xs text-rose-600 hover:text-rose-700 hover:bg-rose-50 dark:hover:bg-rose-950/30 h-8 px-2.5"
                        >
                          {isRemoving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Remove'}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )
          ) : (
            <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-900/50 border border-slate-200/60 dark:border-slate-800/60 flex items-center justify-between">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-400">
                Your Account Access
              </span>
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

      {/* MEMBER PICKER MODAL */}
      {isPickerOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-2xl max-w-lg w-full overflow-hidden flex flex-col max-h-[85vh]">
            {/* Modal Header */}
            <div className="p-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">
                  Add people
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Select active workspace members or invite a new member to this number
                </p>
              </div>
              <button
                onClick={() => setIsPickerOpen(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Search Input */}
            <div className="p-4 border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/40">
              <div className="relative">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search members or enter email..."
                  className="w-full pl-9 pr-4 py-2 text-xs rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  autoFocus
                />
              </div>

              {/* Selected Chips Preview */}
              {selectedUserIds.length > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-1.5 pt-2 border-t border-slate-200/60 dark:border-slate-800/60">
                  <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 mr-1">
                    Selected ({selectedUserIds.length}):
                  </span>
                  {selectedUserIds.map((uId) => {
                    const candidate = unassignedMembers.find((m) => m.id === uId);
                    if (!candidate) return null;
                    return (
                      <span
                        key={uId}
                        className="inline-flex items-center gap-1 text-[11px] font-medium bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800/60 px-2 py-0.5 rounded-full"
                      >
                        <span>{candidate.full_name}</span>
                        <button
                          onClick={() => handleToggleSelectUser(uId)}
                          className="hover:text-blue-900 dark:hover:text-blue-100"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Modal Body / Candidate List */}
            <div className="p-4 overflow-y-auto flex-1 space-y-3">
              {modalFeedback && (
                <div
                  className={`p-3 rounded-xl border text-xs flex items-start gap-2 ${
                    modalFeedback.type === 'success'
                      ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300'
                      : modalFeedback.type === 'warning'
                      ? 'bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300'
                      : 'bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-300'
                  }`}
                >
                  {modalFeedback.type === 'success' ? (
                    <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600 mt-0.5" />
                  ) : modalFeedback.type === 'warning' ? (
                    <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600 mt-0.5" />
                  ) : (
                    <AlertCircle className="w-4 h-4 shrink-0 text-rose-600 mt-0.5" />
                  )}
                  <span>{modalFeedback.message}</span>
                </div>
              )}

              {/* Unassigned Active Workspace Members */}
              {filteredCandidates.length > 0 ? (
                <div className="space-y-1">
                  <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block mb-1">
                    Eligible Workspace Members
                  </span>
                  {filteredCandidates.map((member) => {
                    const isSelected = selectedUserIds.includes(member.id);
                    return (
                      <div
                        key={member.id}
                        onClick={() => handleToggleSelectUser(member.id)}
                        className={`p-3 rounded-xl border cursor-pointer flex items-center justify-between transition-colors ${
                          isSelected
                            ? 'bg-blue-50/70 dark:bg-blue-950/40 border-blue-300 dark:border-blue-700'
                            : 'bg-white dark:bg-slate-900 border-slate-200/80 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50'
                        }`}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => {}}
                            className="w-4 h-4 rounded text-blue-600 focus:ring-blue-500 border-slate-300 dark:border-slate-700"
                          />
                          <div className="w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-700 dark:text-slate-300 font-bold text-xs shrink-0">
                            {member.full_name?.charAt(0).toUpperCase() || 'M'}
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
                                {member.full_name}
                              </span>
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 capitalize">
                                {member.role}
                              </span>
                            </div>
                            <span className="text-[11px] text-slate-500 dark:text-slate-400 truncate block">
                              {member.email}
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : searchQuery && !showInviteOption ? (
                <div className="py-6 text-center text-xs text-slate-400">
                  No matching unassigned active members found.
                </div>
              ) : null}

              {/* Non-workspace Member Invitation Option */}
              {showInviteOption && (
                <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 space-y-2">
                  <div className="flex items-center gap-2">
                    <Mail className="w-4 h-4 text-blue-500 shrink-0" />
                    <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                      Not a workspace member
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3 pt-1">
                    <span className="text-xs text-slate-600 dark:text-slate-400 truncate font-mono">
                      {cleanSearchQuery}
                    </span>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={isSendingInvite}
                      onClick={() => handleInviteNonMember(cleanSearchQuery)}
                      className="text-xs h-8 px-3 shrink-0 gap-1"
                    >
                      {isSendingInvite ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        `Invite ${cleanSearchQuery}`
                      )}
                    </Button>
                  </div>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="p-4 border-t border-slate-100 dark:border-slate-800 flex items-center justify-end gap-3 bg-slate-50/50 dark:bg-slate-950/40">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIsPickerOpen(false)}
                className="text-xs h-9 px-4"
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={selectedUserIds.length === 0 || isSavingAssignments}
                onClick={handleAddSelectedToNumber}
                className="text-xs h-9 px-4 gap-1.5 font-semibold"
              >
                {isSavingAssignments ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  'Add to Number'
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
