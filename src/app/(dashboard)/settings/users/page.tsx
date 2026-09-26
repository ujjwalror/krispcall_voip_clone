'use client';

import React, { useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import {
  Users,
  ShieldCheck,
  UserCheck,
  RefreshCw,
  Circle,
  Layers,
  UserPlus,
  Copy,
  Check,
  X,
  Loader2,
  Mail,
  User,
  Clock,
  Ban,
  AlertTriangle,
  Info,
  ShieldAlert,
  Send,
} from 'lucide-react';

import { useAuth } from '@/components/providers/AuthProvider';

interface Member {
  id: string;
  full_name: string;
  email: string;
  role: 'owner' | 'admin' | 'manager' | 'agent';
  active: boolean;
  extension?: string | null;
  twilio_identity?: string | null;
  availability_status?: 'available' | 'busy' | 'offline' | null;
  last_seen_at?: string | null;
  is_occupied?: boolean;
}

interface Invitation {
  id: string;
  organization_id: string;
  email: string;
  role: 'admin' | 'manager' | 'agent';
  status: 'pending' | 'accepted' | 'cancelled' | 'expired';
  expires_at: string;
  accepted_at?: string | null;
  cancelled_at?: string | null;
  created_at: string;
  invited_by_user_id?: string | null;
  invited_by?: {
    full_name?: string;
    email?: string;
  } | null;
}

interface ConfirmationState {
  title: string;
  message: string;
  actionLabel: string;
  variant: 'danger' | 'warning' | 'primary';
  onConfirm: () => Promise<void>;
}

export default function WorkspaceUsersPage() {
  const { profile } = useAuth();
  const [activeTab, setActiveTab] = useState<'members' | 'invitations'>('members');

  // Data States
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [routingStrategy, setRoutingStrategy] = useState<'ring_all' | 'round_robin'>('ring_all');
  const [preferAssignedAgent, setPreferAssignedAgent] = useState<boolean>(false);
  const [currentUserRole, setCurrentUserRole] = useState<'owner' | 'admin' | 'manager' | 'agent'>('agent');
  
  const [isLoadingMembers, setIsLoadingMembers] = useState(true);
  const [isLoadingInvitations, setIsLoadingInvitations] = useState(false);
  const [isActionLoading, setIsActionLoading] = useState(false);

  // Invite Modal States
  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'admin' | 'manager' | 'agent'>('agent');
  const [isSeatAcknowledged, setIsSeatAcknowledged] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [isSendingInvite, setIsSendingInvite] = useState(false);
  const [devAcceptanceUrl, setDevAcceptanceUrl] = useState<string | null>(null);
  const [isCopiedTestLink, setIsCopiedTestLink] = useState(false);

  // Confirmation Modal State
  const [confirmModal, setConfirmModal] = useState<ConfirmationState | null>(null);

  // Load Workspace Members & Routing Configuration
  const loadWorkspaceMembers = async () => {
    setIsLoadingMembers(true);
    try {
      const res = await fetch('/api/users/manage');
      if (res.ok) {
        const data = await res.json();
        setMembers(data.members || []);
        setCurrentUserRole(data.currentUserRole || 'agent');
        if (data.organization?.routing_strategy) {
          setRoutingStrategy(data.organization.routing_strategy);
        }
        if (data.organization?.prefer_assigned_agent !== undefined) {
          setPreferAssignedAgent(Boolean(data.organization.prefer_assigned_agent));
        }
      }
    } catch (err) {
      console.error('[WorkspaceUsersPage] Load members error:', err);
    } finally {
      setIsLoadingMembers(false);
    }
  };

  // Load Workspace Invitations
  const loadWorkspaceInvitations = async () => {
    setIsLoadingInvitations(true);
    try {
      const res = await fetch('/api/invitations/list');
      if (res.ok) {
        const data = await res.json();
        setInvitations(data.invitations || []);
      }
    } catch (err) {
      console.error('[WorkspaceUsersPage] Load invitations error:', err);
    } finally {
      setIsLoadingInvitations(false);
    }
  };

  const refreshAll = async () => {
    await Promise.all([loadWorkspaceMembers(), loadWorkspaceInvitations()]);
  };

  useEffect(() => {
    refreshAll();
  }, []);

  // Update Inbound Routing Strategy
  const handleUpdateRouting = async (strategy?: 'ring_all' | 'round_robin', preferAssigned?: boolean) => {
    try {
      if (strategy !== undefined) setRoutingStrategy(strategy);
      if (preferAssigned !== undefined) setPreferAssignedAgent(preferAssigned);
      await fetch('/api/users/manage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update_routing',
          ...(strategy ? { routingStrategy: strategy } : {}),
          ...(preferAssigned !== undefined ? { preferAssignedAgent: preferAssigned } : {}),
        }),
      });
    } catch (err) {
      console.error('[WorkspaceUsersPage] Routing update failed:', err);
    }
  };

  // Handle Member Role Change with Confirmation
  const promptChangeRole = (member: Member, newRole: 'admin' | 'manager' | 'agent') => {
    if (member.role === newRole) return;

    setConfirmModal({
      title: 'Change Member Role',
      message: `Are you sure you want to change ${member.full_name}'s role from ${member.role.toUpperCase()} to ${newRole.toUpperCase()}? This will update their administrative access immediately.`,
      actionLabel: 'Confirm Role Change',
      variant: 'primary',
      onConfirm: async () => {
        try {
          setIsActionLoading(true);
          const res = await fetch('/api/users/manage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'update_member',
              userId: member.id,
              role: newRole,
            }),
          });
          if (res.ok) {
            await loadWorkspaceMembers();
          } else {
            const err = await res.json();
            alert(err.error || 'Failed to update member role.');
          }
        } catch (err) {
          console.error('[WorkspaceUsersPage] Role update error:', err);
        } finally {
          setIsActionLoading(false);
          setConfirmModal(null);
        }
      },
    });
  };

  // Handle Member Soft Deactivation / Reactivation
  const promptToggleMemberActive = (member: Member) => {
    const isDeactivating = member.active;
    const actionText = isDeactivating ? 'deactivate' : 'reactivate';

    setConfirmModal({
      title: isDeactivating ? 'Deactivate Workspace Member' : 'Reactivate Workspace Member',
      message: isDeactivating
        ? `Are you sure you want to deactivate ${member.full_name}? They will no longer be able to log in or answer calls. Historical call logs and recordings will be preserved.`
        : `Are you sure you want to reactivate ${member.full_name}? They will regain access to the workspace.`,
      actionLabel: isDeactivating ? 'Deactivate Member' : 'Reactivate Member',
      variant: isDeactivating ? 'danger' : 'primary',
      onConfirm: async () => {
        try {
          setIsActionLoading(true);
          const res = await fetch('/api/users/manage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'update_member',
              userId: member.id,
              active: !member.active,
            }),
          });
          if (res.ok) {
            await loadWorkspaceMembers();
          } else {
            const err = await res.json();
            alert(err.error || `Failed to ${actionText} member.`);
          }
        } catch (err) {
          console.error(`[WorkspaceUsersPage] ${actionText} member error:`, err);
        } finally {
          setIsActionLoading(false);
          setConfirmModal(null);
        }
      },
    });
  };

  // Handle Extension Change
  const handleUpdateExtension = async (member: Member, newExtension: string) => {
    const trimmed = newExtension.trim();
    if (trimmed === (member.extension || '')) return;

    try {
      setIsActionLoading(true);
      const res = await fetch('/api/users/manage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update_member',
          userId: member.id,
          extension: trimmed,
        }),
      });
      if (res.ok) {
        await loadWorkspaceMembers();
      } else {
        const err = await res.json();
        alert(err.error || 'Failed to update extension.');
      }
    } catch (err) {
      console.error('[WorkspaceUsersPage] Extension update error:', err);
    } finally {
      setIsActionLoading(false);
    }
  };

  // Handle Invitation Cancellation
  const promptCancelInvitation = (invite: Invitation) => {
    setConfirmModal({
      title: 'Cancel Pending Invitation',
      message: `Are you sure you want to cancel the pending invitation sent to ${invite.email}? The invitation link will immediately become invalid.`,
      actionLabel: 'Cancel Invitation',
      variant: 'danger',
      onConfirm: async () => {
        try {
          setIsActionLoading(true);
          const res = await fetch('/api/invitations/cancel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ invitationId: invite.id }),
          });
          if (res.ok) {
            await loadWorkspaceInvitations();
          } else {
            const err = await res.json();
            alert(err.error || 'Failed to cancel invitation.');
          }
        } catch (err) {
          console.error('[WorkspaceUsersPage] Cancel invitation error:', err);
        } finally {
          setIsActionLoading(false);
          setConfirmModal(null);
        }
      },
    });
  };

  // Handle Send Invitation Submit
  const handleSendInvitation = async (e: React.FormEvent) => {
    e.preventDefault();
    setInviteError(null);
    setDevAcceptanceUrl(null);

    if (!inviteEmail.trim() || !inviteEmail.includes('@')) {
      setInviteError('Please enter a valid email address.');
      return;
    }

    try {
      setIsSendingInvite(true);
      const res = await fetch('/api/invitations/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: inviteEmail.trim(),
          role: inviteRole,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setInviteError(data.error || 'Failed to send invitation.');
        return;
      }

      // Success
      setInviteEmail('');
      setInviteRole('agent');
      setIsSeatAcknowledged(false);
      await refreshAll();

      if (data.acceptanceUrl) {
        setDevAcceptanceUrl(data.acceptanceUrl);
      } else {
        setIsInviteModalOpen(false);
      }
    } catch (err: any) {
      console.error('[WorkspaceUsersPage] Send invitation exception:', err);
      setInviteError(err.message || 'An unexpected error occurred while sending the invitation.');
    } finally {
      setIsSendingInvite(false);
    }
  };

  const handleCopyTestLink = () => {
    if (!devAcceptanceUrl) return;
    navigator.clipboard.writeText(devAcceptanceUrl);
    setIsCopiedTestLink(true);
    setTimeout(() => setIsCopiedTestLink(false), 3000);
  };

  // Calculate Counts
  const activeMembersCount = members.filter((m) => m.active).length;
  const pendingInvitesCount = invitations.filter((i) => i.status === 'pending').length;

  const getPresenceIndicator = (member: Member) => {
    const status = member.availability_status || 'offline';
    const isRecentlyActive =
      member.last_seen_at &&
      Date.now() - new Date(member.last_seen_at).getTime() < 2 * 60 * 1000;

    if (status === 'available' && isRecentlyActive) {
      return { label: 'Available', color: 'bg-emerald-500' };
    }
    if (status === 'busy') {
      return { label: 'Busy / In Call', color: 'bg-amber-500' };
    }
    return { label: 'Offline', color: 'bg-slate-500' };
  };

  // Determine allowed invite roles depending on requester authority
  const canInviteMembers = ['owner', 'admin'].includes(currentUserRole);

  return (
    <div className="space-y-6 max-w-6xl mx-auto pb-16">
      {/* Page Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-5">
        <div>
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-blue-50 dark:bg-blue-600/10 border border-blue-200 dark:border-blue-500/20 text-blue-600 dark:text-blue-400">
              <Users className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">Team & Users</h1>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Manage the people who have access to your workspace.
              </p>
            </div>
          </div>
        </div>

        {/* Stats & Primary Action */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Active Members Counter */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs font-mono">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-slate-500 dark:text-slate-400">Active Members:</span>
            <span className="font-bold text-slate-900 dark:text-slate-100">{activeMembersCount}</span>
          </div>

          {/* Pending Invitations Counter */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs font-mono">
            <span className="w-2 h-2 rounded-full bg-amber-500" />
            <span className="text-slate-500 dark:text-slate-400">Pending Invites:</span>
            <span className="font-bold text-slate-900 dark:text-slate-100">{pendingInvitesCount}</span>
          </div>

          {/* Refresh Button */}
          <Button
            variant="outline"
            size="sm"
            onClick={refreshAll}
            disabled={isLoadingMembers || isLoadingInvitations}
            className="text-xs"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoadingMembers || isLoadingInvitations ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">Refresh</span>
          </Button>

          {/* Invite Member Button (OWNER & ADMIN ONLY) */}
          {canInviteMembers && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                setInviteError(null);
                setDevAcceptanceUrl(null);
                setInviteEmail('');
                setInviteRole('agent');
                setIsSeatAcknowledged(false);
                setIsInviteModalOpen(true);
              }}
              className="bg-blue-600 hover:bg-blue-500 shadow-md shadow-blue-600/20 focus:ring-2 focus:ring-blue-500/40 font-semibold text-xs text-white"
            >
              <UserPlus className="w-4 h-4" />
              <span>Invite Member</span>
            </Button>
          )}
        </div>
      </div>

      {/* Tabs Bar */}
      <div className="flex border-b border-slate-200 dark:border-slate-800">
        <button
          onClick={() => setActiveTab('members')}
          className={`flex items-center gap-2 px-4 py-3 text-xs font-bold border-b-2 transition-all ${
            activeTab === 'members'
              ? 'border-blue-600 text-blue-600 dark:text-blue-400 dark:border-blue-400'
              : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
          }`}
        >
          <Users className="w-4 h-4" />
          <span>MEMBERS ({members.length})</span>
        </button>

        <button
          onClick={() => setActiveTab('invitations')}
          className={`flex items-center gap-2 px-4 py-3 text-xs font-bold border-b-2 transition-all relative ${
            activeTab === 'invitations'
              ? 'border-blue-600 text-blue-600 dark:text-blue-400 dark:border-blue-400'
              : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
          }`}
        >
          <Mail className="w-4 h-4" />
          <span>PENDING INVITATIONS</span>
          {pendingInvitesCount > 0 && (
            <span className="px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-600 dark:text-amber-400 text-[10px] font-mono font-bold">
              {pendingInvitesCount}
            </span>
          )}
        </button>
      </div>

      {/* TAB 1: MEMBERS */}
      {activeTab === 'members' && (
        <div className="space-y-6">
          {/* Call Routing Strategy Settings Card (Available to Owner & Admin) */}
          {['owner', 'admin'].includes(currentUserRole) && (
            <Card className="p-4 bg-white dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 rounded-2xl backdrop-blur-sm space-y-3">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <Layers className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                    <h2 className="text-xs font-bold text-slate-900 dark:text-slate-100 uppercase tracking-wide">
                      Inbound Routing Settings
                    </h2>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Configure how incoming business calls are routed among active team members.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  {/* Ring Strategy Selector */}
                  <div className="flex items-center gap-1 bg-slate-100 dark:bg-slate-950 p-1 rounded-xl border border-slate-200 dark:border-slate-800">
                    <button
                      onClick={() => handleUpdateRouting('ring_all', undefined)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                        routingStrategy === 'ring_all'
                          ? 'bg-blue-600 text-white font-bold shadow-sm'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                      }`}
                    >
                      Ring All
                    </button>
                    <button
                      onClick={() => handleUpdateRouting('round_robin', undefined)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                        routingStrategy === 'round_robin'
                          ? 'bg-blue-600 text-white font-bold shadow-sm'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                      }`}
                    >
                      Round Robin
                    </button>
                  </div>

                  {/* Prefer Assigned Agent Toggle */}
                  <button
                    onClick={() => handleUpdateRouting(undefined, !preferAssignedAgent)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-medium border transition-all flex items-center gap-1.5 ${
                      preferAssignedAgent
                        ? 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-300 dark:border-emerald-500/40 text-emerald-700 dark:text-emerald-300 font-bold'
                        : 'bg-slate-100 dark:bg-slate-950 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    <UserCheck className="w-3.5 h-3.5" />
                    <span>Prefer Assigned Agent: {preferAssignedAgent ? 'ON' : 'OFF'}</span>
                  </button>
                </div>
              </div>
            </Card>
          )}

          {/* Members Table / List */}
          {isLoadingMembers ? (
            <Card className="p-12 text-center text-xs text-slate-500">
              <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-blue-600 dark:text-blue-400" />
              <span>Loading workspace members...</span>
            </Card>
          ) : members.length === 0 ? (
            <Card className="p-12 text-center text-xs text-slate-500">
              <Users className="w-8 h-8 mx-auto mb-2 text-slate-400" />
              <span>No workspace members found.</span>
            </Card>
          ) : (
            <div className="space-y-3">
              {/* Desktop Table Header */}
              <div className="hidden lg:grid grid-cols-12 gap-4 px-4 py-2 text-[10px] font-mono uppercase font-bold text-slate-400 dark:text-slate-500">
                <div className="col-span-4">Member</div>
                <div className="col-span-2">Role</div>
                <div className="col-span-2">Extension</div>
                <div className="col-span-2">Status</div>
                <div className="col-span-2 text-right">Actions</div>
              </div>

              {/* Members Rows */}
              {members.map((member) => {
                const presence = getPresenceIndicator(member);
                const isSelf = profile?.id === member.id;
                const isOwnerRow = member.role === 'owner';
                const isAdminRow = member.role === 'admin';

                // Determine row editing authority based on strict role hierarchy
                let canChangeRole = false;
                let canToggleActive = false;

                if (currentUserRole === 'owner') {
                  if (!isOwnerRow) {
                    canChangeRole = true;
                    canToggleActive = true;
                  }
                } else if (currentUserRole === 'admin') {
                  if (!isOwnerRow && !isAdminRow) {
                    canChangeRole = true;
                    canToggleActive = true;
                  }
                }

                return (
                  <Card
                    key={member.id}
                    className={`p-4 bg-white dark:bg-slate-900/70 border transition-all rounded-xl ${
                      !member.active
                        ? 'border-slate-200/60 dark:border-slate-800/50 opacity-60'
                        : 'border-slate-200 dark:border-slate-800/80 hover:border-slate-300 dark:hover:border-slate-700'
                    }`}
                  >
                    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-center">
                      {/* Member Info (Col 4) */}
                      <div className="lg:col-span-4 flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-blue-100 dark:bg-blue-600/20 border border-blue-200 dark:border-blue-500/30 text-blue-700 dark:text-blue-300 font-bold flex items-center justify-center text-xs font-mono shrink-0">
                          {member.full_name
                            ? member.full_name
                                .split(' ')
                                .map((n) => n[0])
                                .join('')
                                .substring(0, 2)
                                .toUpperCase()
                            : member.email.substring(0, 2).toUpperCase()}
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 truncate">
                              {member.full_name || 'Unnamed Member'}
                            </h3>
                            {isSelf && (
                              <span className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-[9px] font-mono text-slate-500 uppercase shrink-0">
                                You
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-slate-500 dark:text-slate-400 font-mono truncate">
                            {member.email}
                          </p>
                        </div>
                      </div>

                      {/* Role Badge / Selector (Col 2) */}
                      <div className="lg:col-span-2 flex items-center">
                        {canChangeRole ? (
                          <select
                            value={member.role}
                            onChange={(e) =>
                              promptChangeRole(member, e.target.value as 'admin' | 'manager' | 'agent')
                            }
                            disabled={isActionLoading}
                            className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg px-2.5 py-1 text-xs text-slate-900 dark:text-slate-100 font-semibold focus:outline-none focus:border-blue-500"
                          >
                            {currentUserRole === 'owner' && <option value="admin">Admin</option>}
                            <option value="manager">Manager</option>
                            <option value="agent">Agent</option>
                          </select>
                        ) : (
                          <Badge
                            variant={
                              isOwnerRow
                                ? 'purple'
                                : isAdminRow
                                ? 'purple'
                                : member.role === 'manager'
                                ? 'blue'
                                : 'emerald'
                            }
                            size="sm"
                            className="uppercase text-[9px] shrink-0 font-bold"
                          >
                            {(isOwnerRow || isAdminRow) && <ShieldCheck className="w-2.5 h-2.5 mr-1" />}
                            {member.role}
                          </Badge>
                        )}
                      </div>

                      {/* Extension (Col 2) */}
                      <div className="lg:col-span-2 flex items-center">
                        {canChangeRole ? (
                          <div className="flex items-center gap-1">
                            <span className="text-[10px] text-slate-400 font-mono">Ext:</span>
                            <input
                              type="text"
                              defaultValue={member.extension || ''}
                              onBlur={(e) => handleUpdateExtension(member, e.target.value)}
                              placeholder="—"
                              className="w-16 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg px-2 py-0.5 text-xs font-mono text-slate-900 dark:text-slate-100 text-center focus:outline-none focus:border-blue-500"
                            />
                          </div>
                        ) : (
                          <span className="text-xs font-mono text-slate-700 dark:text-slate-300">
                            {member.extension ? `Ext ${member.extension}` : '—'}
                          </span>
                        )}
                      </div>

                      {/* Status (Col 2) */}
                      <div className="lg:col-span-2 flex items-center gap-2">
                        {member.active ? (
                          <div className="flex items-center gap-1.5">
                            <span className={`w-2 h-2 rounded-full ${presence.color}`} />
                            <span className="text-xs text-slate-700 dark:text-slate-300 font-medium">
                              Active
                            </span>
                          </div>
                        ) : (
                          <Badge variant="rose" size="sm" className="text-[9px]">
                            Inactive
                          </Badge>
                        )}
                      </div>

                      {/* Actions (Col 2) */}
                      <div className="lg:col-span-2 flex items-center justify-end gap-2">
                        {canToggleActive ? (
                          <button
                            onClick={() => promptToggleMemberActive(member)}
                            disabled={isActionLoading}
                            className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
                              member.active
                                ? 'bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-400 border border-rose-200 dark:border-rose-500/30 hover:bg-rose-100 dark:hover:bg-rose-500/20'
                                : 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-500/30 hover:bg-emerald-100 dark:hover:bg-emerald-500/20'
                            }`}
                          >
                            {member.active ? 'Deactivate' : 'Reactivate'}
                          </button>
                        ) : isOwnerRow ? (
                          <span className="text-[10px] font-mono text-slate-400 italic">Workspace Owner</span>
                        ) : isSelf ? (
                          <span className="text-[10px] font-mono text-slate-400 italic">Current Session</span>
                        ) : (
                          <span className="text-[10px] font-mono text-slate-400 italic">Read-Only</span>
                        )}
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* TAB 2: PENDING INVITATIONS */}
      {activeTab === 'invitations' && (
        <div className="space-y-4">
          {isLoadingInvitations ? (
            <Card className="p-12 text-center text-xs text-slate-500">
              <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-blue-600 dark:text-blue-400" />
              <span>Loading workspace invitations...</span>
            </Card>
          ) : invitations.length === 0 ? (
            <Card className="p-12 text-center text-xs text-slate-500 space-y-3">
              <Mail className="w-8 h-8 mx-auto text-slate-400" />
              <div>
                <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300">No Pending Invitations</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  When you invite team members, their invitation status will appear here.
                </p>
              </div>
              {canInviteMembers && (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => setIsInviteModalOpen(true)}
                  className="bg-blue-600 hover:bg-blue-500 text-xs font-semibold text-white"
                >
                  <UserPlus className="w-4 h-4" />
                  <span>Send First Invitation</span>
                </Button>
              )}
            </Card>
          ) : (
            <div className="space-y-3">
              {/* Table Header */}
              <div className="hidden lg:grid grid-cols-12 gap-4 px-4 py-2 text-[10px] font-mono uppercase font-bold text-slate-400 dark:text-slate-500">
                <div className="col-span-3">Email Address</div>
                <div className="col-span-2">Role</div>
                <div className="col-span-3">Invited By</div>
                <div className="col-span-2">Status</div>
                <div className="col-span-2 text-right">Actions</div>
              </div>

              {invitations.map((invite) => {
                const isPending = invite.status === 'pending';
                const createdDateStr = new Date(invite.created_at).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                });

                let canCancel = false;
                if (isPending) {
                  if (currentUserRole === 'owner') canCancel = true;
                  else if (currentUserRole === 'admin' && invite.role !== 'admin') canCancel = true;
                }

                return (
                  <Card
                    key={invite.id}
                    className="p-4 bg-white dark:bg-slate-900/70 border border-slate-200 dark:border-slate-800/80 rounded-xl"
                  >
                    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-center">
                      {/* Email (Col 3) */}
                      <div className="lg:col-span-3 flex items-center gap-2.5">
                        <div className="p-2 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/40 text-amber-600 dark:text-amber-400 shrink-0">
                          <Mail className="w-4 h-4" />
                        </div>
                        <div className="min-w-0">
                          <span className="text-sm font-bold text-slate-900 dark:text-slate-100 font-mono truncate block">
                            {invite.email}
                          </span>
                          <span className="text-[10px] text-slate-400 font-mono">
                            Sent {createdDateStr}
                          </span>
                        </div>
                      </div>

                      {/* Role (Col 2) */}
                      <div className="lg:col-span-2 flex items-center">
                        <Badge
                          variant={
                            invite.role === 'admin'
                              ? 'purple'
                              : invite.role === 'manager'
                              ? 'blue'
                              : 'emerald'
                          }
                          size="sm"
                          className="uppercase text-[9px] font-bold"
                        >
                          {invite.role}
                        </Badge>
                      </div>

                      {/* Invited By (Col 3) */}
                      <div className="lg:col-span-3 flex items-center text-xs text-slate-600 dark:text-slate-400 font-mono truncate">
                        <span>{invite.invited_by?.full_name || invite.invited_by?.email || 'Workspace Owner'}</span>
                      </div>

                      {/* Status (Col 2) */}
                      <div className="lg:col-span-2 flex items-center gap-1.5">
                        <Badge
                          variant={
                            invite.status === 'pending'
                              ? 'amber'
                              : invite.status === 'accepted'
                              ? 'emerald'
                              : 'neutral'
                          }
                          size="sm"
                          className="uppercase text-[9px]"
                        >
                          {invite.status}
                        </Badge>
                      </div>

                      {/* Actions (Col 2) */}
                      <div className="lg:col-span-2 flex items-center justify-end gap-2">
                        {canCancel && (
                          <button
                            onClick={() => promptCancelInvitation(invite)}
                            disabled={isActionLoading}
                            className="px-3 py-1 rounded-lg text-xs font-medium bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-400 border border-rose-200 dark:border-rose-500/30 hover:bg-rose-100 dark:hover:bg-rose-500/20 transition-colors"
                          >
                            Cancel
                          </button>
                        )}
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* INVITE TEAM MEMBER MODAL */}
      {isInviteModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-md p-4 animate-in fade-in duration-200">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl w-full max-w-md p-6 relative">
            <button
              onClick={() => {
                setIsInviteModalOpen(false);
                setIsSeatAcknowledged(false);
                setDevAcceptanceUrl(null);
              }}
              className="absolute right-4 top-4 text-slate-400 hover:text-slate-700 dark:hover:text-slate-100 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>

            {!devAcceptanceUrl ? (
              <>
                <div className="flex items-center gap-3 mb-5">
                  <div className="p-2.5 rounded-xl bg-blue-50 dark:bg-blue-600/10 border border-blue-200 dark:border-blue-500/20 text-blue-600 dark:text-blue-400">
                    <UserPlus className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">Invite Team Member</h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Send an invitation link to join your workspace
                    </p>
                  </div>
                </div>

                {inviteError && (
                  <div className="mb-4 p-3 rounded-xl bg-rose-50 dark:bg-rose-950/60 border border-rose-200 dark:border-rose-800/80 text-xs text-rose-800 dark:text-rose-300 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
                    <span>{inviteError}</span>
                  </div>
                )}

                <form onSubmit={handleSendInvitation} className="space-y-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-800 dark:text-slate-300 mb-1">
                      Email Address *
                    </label>
                    <div className="relative">
                      <Mail className="w-4 h-4 text-slate-400 dark:text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                      <input
                        type="email"
                        required
                        placeholder="colleague@company.com"
                        value={inviteEmail}
                        onChange={(e) => setInviteEmail(e.target.value)}
                        className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl pl-9 pr-3 py-2 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:border-blue-500"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-800 dark:text-slate-300 mb-1">
                      Role *
                    </label>
                    <select
                      value={inviteRole}
                      onChange={(e) => setInviteRole(e.target.value as any)}
                      className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-900 dark:text-slate-100 font-medium focus:outline-none focus:border-blue-500"
                    >
                      {currentUserRole === 'owner' && <option value="admin">Admin</option>}
                      <option value="manager">Manager</option>
                      <option value="agent">Agent</option>
                    </select>
                  </div>

                  {/* TODO (Phase 5/6): Replace generic notice & acknowledgment with dynamic entitlement and billing information including:
                      - included seats
                      - available seats
                      - additional seat price
                      - prorated amount
                      - subscription quantity adjustment */}
                  <div className="p-3.5 rounded-xl bg-blue-50/80 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800/60 space-y-1.5">
                    <div className="flex items-center gap-2 text-blue-700 dark:text-blue-300 font-bold text-xs">
                      <Info className="w-4 h-4 shrink-0 text-blue-600 dark:text-blue-400" />
                      <span>Additional seat charges</span>
                    </div>
                    <p className="text-[11px] text-slate-600 dark:text-slate-300 leading-relaxed pl-6">
                      Sending this invitation does not incur a charge. If this member accepts the invitation and becomes an active member of your workspace, an additional seat charge may be added to your subscription based on your plan and billing cycle.
                    </p>
                  </div>

                  {/* Seat Acknowledgment Checkbox */}
                  <div className="flex items-start gap-2.5 pt-1">
                    <input
                      type="checkbox"
                      id="acknowledgeSeat"
                      checked={isSeatAcknowledged}
                      onChange={(e) => setIsSeatAcknowledged(e.target.checked)}
                      className="mt-0.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                    />
                    <label
                      htmlFor="acknowledgeSeat"
                      className="text-xs text-slate-600 dark:text-slate-300 cursor-pointer select-none leading-tight"
                    >
                      I understand that if this member accepts, an additional seat charge may apply to my subscription.
                    </label>
                  </div>

                  <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-100 dark:border-slate-800">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setIsInviteModalOpen(false);
                        setIsSeatAcknowledged(false);
                      }}
                      disabled={isSendingInvite}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="submit"
                      variant="primary"
                      size="sm"
                      disabled={isSendingInvite || !isSeatAcknowledged}
                      className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed font-semibold text-xs text-white"
                    >
                      {isSendingInvite ? (
                        <>
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          <span>Sending...</span>
                        </>
                      ) : (
                        <>
                          <Send className="w-3.5 h-3.5" />
                          <span>Send Invitation</span>
                        </>
                      )}
                    </Button>
                  </div>
                </form>
              </>
            ) : (
              /* Local Development Test Acceptance Link Banner */
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 rounded-xl bg-emerald-50 dark:bg-emerald-600/10 border border-emerald-200 dark:border-emerald-500/20 text-emerald-600 dark:text-emerald-400">
                    <Check className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">Invitation Sent</h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Pending invitation recorded successfully
                    </p>
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-400 font-mono text-[10px]">DEVELOPMENT TESTING ONLY</span>
                  </div>
                  <p className="text-xs text-slate-600 dark:text-slate-300">
                    Use this test link to complete recipient invitation acceptance locally:
                  </p>
                  <div className="p-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg font-mono text-[11px] text-blue-600 dark:text-blue-400 break-all select-all">
                    {devAcceptanceUrl}
                  </div>
                </div>

                <div className="flex items-center gap-3 pt-2">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={handleCopyTestLink}
                    className="w-full bg-emerald-600 hover:bg-emerald-500 font-semibold text-xs text-white"
                  >
                    {isCopiedTestLink ? (
                      <>
                        <Check className="w-4 h-4" />
                        <span>Link Copied!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-4 h-4" />
                        <span>Copy Test Invitation Link</span>
                      </>
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setIsInviteModalOpen(false);
                      setDevAcceptanceUrl(null);
                    }}
                  >
                    Done
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* CONFIRMATION MODAL */}
      {confirmModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-md p-4 animate-in fade-in duration-200">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl w-full max-w-md p-6 relative">
            <div className="flex items-center gap-3 mb-4">
              <div
                className={`p-2.5 rounded-xl border ${
                  confirmModal.variant === 'danger'
                    ? 'bg-rose-50 dark:bg-rose-600/10 border-rose-200 dark:border-rose-500/20 text-rose-600 dark:text-rose-400'
                    : 'bg-blue-50 dark:bg-blue-600/10 border-blue-200 dark:border-blue-500/20 text-blue-600 dark:text-blue-400'
                }`}
              >
                <AlertTriangle className="w-5 h-5" />
              </div>
              <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">
                {confirmModal.title}
              </h3>
            </div>

            <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed mb-6">
              {confirmModal.message}
            </p>

            <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-100 dark:border-slate-800">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmModal(null)}
                disabled={isActionLoading}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={confirmModal.onConfirm}
                disabled={isActionLoading}
                className={
                  confirmModal.variant === 'danger'
                    ? 'bg-rose-600 hover:bg-rose-500 text-xs font-semibold text-white'
                    : 'bg-blue-600 hover:bg-blue-500 text-xs font-semibold text-white'
                }
              >
                {isActionLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <span>{confirmModal.actionLabel}</span>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
