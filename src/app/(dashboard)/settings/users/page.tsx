'use client';

import React, { useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import {
  Users,
  ShieldCheck,
  UserCheck,
  PhoneCall,
  RefreshCw,
  Save,
  Circle,
  Layers,
  UserPlus,
  Copy,
  Check,
  X,
  Loader2,
  Lock,
  Mail,
  User,
  Hash,
} from 'lucide-react';

interface Member {
  id: string;
  full_name: string;
  email: string;
  role: 'admin' | 'manager' | 'agent';
  active: boolean;
  extension?: string | null;
  twilio_identity?: string | null;
  availability_status?: 'available' | 'busy' | 'offline' | null;
  last_seen_at?: string | null;
}

interface CreatedUserResult {
  id: string;
  fullName: string;
  email: string;
  password: string;
  role: string;
  extension: string;
  twilioIdentity: string;
}

export default function WorkspaceUsersPage() {
  const [members, setMembers] = useState<Member[]>([]);
  const [routingStrategy, setRoutingStrategy] = useState<'ring_all' | 'round_robin'>('ring_all');
  const [currentUserRole, setCurrentUserRole] = useState<string>('agent');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  // Add User Modal State
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    fullName: '',
    email: '',
    password: '',
    role: 'agent' as 'admin' | 'manager' | 'agent',
    extension: '',
  });

  // Created User Success Screen State
  const [createdUserResult, setCreatedUserResult] = useState<CreatedUserResult | null>(null);
  const [isCopied, setIsCopied] = useState(false);

  const loadWorkspaceData = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/users/manage');
      if (res.ok) {
        const data = await res.json();
        setMembers(data.members || []);
        setCurrentUserRole(data.currentUserRole || 'agent');
        if (data.organization?.routing_strategy) {
          setRoutingStrategy(data.organization.routing_strategy);
        }
      }
    } catch (err) {
      console.error('[WorkspaceUsersPage] Load error:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadWorkspaceData();
  }, []);

  const handleUpdateMember = async (userId: string, updates: Partial<Member>) => {
    try {
      setIsSaving(true);
      const res = await fetch('/api/users/manage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update_member',
          userId,
          ...updates,
        }),
      });

      if (res.ok) {
        await loadWorkspaceData();
      } else {
        const errData = await res.json();
        alert(errData.error || 'Failed to update user.');
      }
    } catch (err) {
      console.error('[WorkspaceUsersPage] Update failed:', err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleUpdateRouting = async (strategy: 'ring_all' | 'round_robin') => {
    try {
      setRoutingStrategy(strategy);
      await fetch('/api/users/manage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update_routing',
          routingStrategy: strategy,
        }),
      });
    } catch (err) {
      console.error('[WorkspaceUsersPage] Routing update failed:', err);
    }
  };

  const handleCreateUserSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!formData.fullName.trim() || !formData.email.trim() || !formData.password) {
      setFormError('Please fill out all required fields.');
      return;
    }

    try {
      setIsCreating(true);
      const res = await fetch('/api/users/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });

      const data = await res.json();

      if (!res.ok) {
        setFormError(data.error || 'Failed to create user.');
        return;
      }

      // Close Form Modal & Open Success Screen
      setIsAddModalOpen(false);
      setCreatedUserResult(data.user);
      setFormData({
        fullName: '',
        email: '',
        password: '',
        role: 'agent',
        extension: '',
      });
      await loadWorkspaceData();
    } catch (err: any) {
      console.error('[WorkspaceUsersPage] Create user error:', err);
      setFormError(err.message || 'An error occurred while creating the user.');
    } finally {
      setIsCreating(false);
    }
  };

  const handleCopyCredentials = () => {
    if (!createdUserResult) return;

    const copyText = `Welcome to VoIP Hub.

Login Email:
${createdUserResult.email}

Temporary Password:
${createdUserResult.password}

Please change your password after first login.`;

    navigator.clipboard.writeText(copyText);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 3000);
  };

  const getPresenceIndicator = (member: Member) => {
    const status = member.availability_status || 'offline';
    const isRecentlyActive =
      member.last_seen_at &&
      Date.now() - new Date(member.last_seen_at).getTime() < 2 * 60 * 1000;

    if (status === 'available' && isRecentlyActive) {
      return { label: 'Available', color: 'bg-emerald-500', badge: 'emerald' };
    }
    if (status === 'busy') {
      return { label: 'Busy / In Call', color: 'bg-amber-500', badge: 'amber' };
    }
    return { label: 'Offline', color: 'bg-slate-500', badge: 'slate' };
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto pb-12">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-5">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-purple-600/10 border border-purple-500/20 text-purple-400">
              <Users className="w-5 h-5" />
            </div>
            <h1 className="text-xl font-bold text-slate-100">Multi-Agent Workspace Management</h1>
            <Badge variant="purple" size="md">
              {members.length} MEMBERS
            </Badge>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Manage agent roles, extensions, availability status, and inbound call routing rules.
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Add User Button (ADMIN ONLY) */}
          {currentUserRole === 'admin' && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                setFormError(null);
                setIsAddModalOpen(true);
              }}
              className="bg-blue-600 hover:bg-blue-500 shadow-md shadow-blue-600/20 font-semibold"
            >
              <UserPlus className="w-4 h-4" />
              <span>Add User</span>
            </Button>
          )}

          <Button variant="outline" size="sm" onClick={loadWorkspaceData} disabled={isLoading}>
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            <span>Refresh Team</span>
          </Button>
        </div>
      </div>

      {/* Call Routing Strategy Card */}
      <Card className="p-5 bg-slate-900/60 border border-slate-800 rounded-2xl backdrop-blur-sm">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-blue-400" />
              <h2 className="text-sm font-bold text-slate-100">Inbound Call Routing Strategy</h2>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Choose how incoming customer calls on the shared company number are distributed among available agents.
            </p>
          </div>

          <div className="flex items-center gap-2 bg-slate-950 p-1 rounded-xl border border-slate-800">
            <button
              onClick={() => handleUpdateRouting('ring_all')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                routingStrategy === 'ring_all'
                  ? 'bg-blue-600 text-white font-bold shadow-md'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Ring All (Simultaneous)
            </button>
            <button
              onClick={() => handleUpdateRouting('round_robin')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                routingStrategy === 'round_robin'
                  ? 'bg-blue-600 text-white font-bold shadow-md'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Round Robin (Sequential)
            </button>
          </div>
        </div>
      </Card>

      {/* Workspace Users List */}
      <div className="space-y-3">
        <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider font-mono px-1">
          Workspace Team Members ({members.length})
        </h2>

        {isLoading ? (
          <Card className="p-8 text-center text-xs text-slate-500">
            <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2 text-blue-400" />
            <span>Loading workspace team members...</span>
          </Card>
        ) : (
          members.map((member) => {
            const presence = getPresenceIndicator(member);
            const canManage = ['admin', 'manager'].includes(currentUserRole);

            return (
              <Card
                key={member.id}
                className={`p-4 bg-slate-900/60 border transition-all rounded-xl ${
                  !member.active
                    ? 'border-slate-800/50 opacity-60'
                    : 'border-slate-800 hover:border-slate-700/80'
                }`}
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  {/* Member Info */}
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-blue-600/20 border border-blue-500/30 text-blue-300 font-bold flex items-center justify-center text-sm font-mono">
                      {member.full_name
                        .split(' ')
                        .map((n) => n[0])
                        .join('')
                        .substring(0, 2)
                        .toUpperCase()}
                    </div>

                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-bold text-slate-100">{member.full_name}</h3>
                        <Badge
                          variant={member.role === 'admin' ? 'purple' : member.role === 'manager' ? 'blue' : 'emerald'}
                          size="sm"
                          className="uppercase text-[9px]"
                        >
                          {member.role === 'admin' && <ShieldCheck className="w-2.5 h-2.5 mr-0.5" />}
                          {member.role}
                        </Badge>
                        {member.active ? (
                          <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-950 border border-slate-800 text-[10px] text-slate-400 font-mono">
                            <Circle className={`w-2 h-2 fill-current ${presence.color}`} />
                            {presence.label}
                          </span>
                        ) : (
                          <Badge variant="rose" size="sm" className="text-[9px]">
                            Disabled
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-slate-400 font-mono mt-0.5">
                        {member.email} • Ext: <span className="text-blue-400">{member.extension || 'Unassigned'}</span> • Identity: <span className="text-slate-300">{member.twilio_identity}</span>
                      </p>
                    </div>
                  </div>

                  {/* Actions / Edit Form */}
                  {canManage && (
                    <div className="flex items-center gap-3 bg-slate-950/80 p-2 rounded-xl border border-slate-800/80">
                      {/* Full Name Edit */}
                      <input
                        type="text"
                        defaultValue={member.full_name}
                        onBlur={(e) => {
                          if (e.target.value !== member.full_name) {
                            handleUpdateMember(member.id, { full_name: e.target.value });
                          }
                        }}
                        className="w-32 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-200 focus:outline-none"
                        title="Edit Full Name"
                      />

                      {/* Role Dropdown */}
                      <select
                        value={member.role}
                        onChange={(e) =>
                          handleUpdateMember(member.id, { role: e.target.value as any })
                        }
                        className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-200 focus:outline-none"
                      >
                        <option value="admin">Admin</option>
                        <option value="manager">Manager</option>
                        <option value="agent">Agent</option>
                      </select>

                      {/* Extension Input */}
                      <input
                        type="text"
                        placeholder="Ext"
                        defaultValue={member.extension || ''}
                        onBlur={(e) => {
                          if (e.target.value !== (member.extension || '')) {
                            handleUpdateMember(member.id, { extension: e.target.value });
                          }
                        }}
                        className="w-16 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-200 font-mono text-center focus:outline-none"
                        title="Edit Extension"
                      />

                      {/* Active Toggle */}
                      <button
                        onClick={() => handleUpdateMember(member.id, { active: !member.active })}
                        className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                          member.active
                            ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                            : 'bg-rose-500/10 text-rose-400 border border-rose-500/30'
                        }`}
                      >
                        {member.active ? 'Active' : 'Disabled'}
                      </button>
                    </div>
                  )}
                </div>
              </Card>
            );
          })
        )}
      </div>

      {/* Add User Modal */}
      {isAddModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-md p-4 animate-in fade-in duration-200">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl w-full max-w-md p-6 relative">
            <button
              onClick={() => setIsAddModalOpen(false)}
              className="absolute right-4 top-4 text-slate-400 hover:text-white transition-colors"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-2.5 mb-5">
              <div className="p-2 rounded-xl bg-blue-600/10 border border-blue-500/20 text-blue-400">
                <UserPlus className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-100">Add New Team Member</h3>
                <p className="text-xs text-slate-400">Create workspace user profile & credentials</p>
              </div>
            </div>

            {formError && (
              <div className="mb-4 p-3 rounded-xl bg-rose-950/60 border border-rose-800/80 text-xs text-rose-300">
                {formError}
              </div>
            )}

            <form onSubmit={handleCreateUserSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">Full Name *</label>
                <div className="relative">
                  <User className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    required
                    placeholder="Simran Kaur"
                    value={formData.fullName}
                    onChange={(e) => setFormData({ ...formData, fullName: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-9 pr-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">Email Address *</label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="email"
                    required
                    placeholder="simran@company.com"
                    value={formData.email}
                    onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-9 pr-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">Temporary Password *</label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="password"
                    required
                    placeholder="••••••••"
                    value={formData.password}
                    onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-9 pr-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">Role</label>
                  <select
                    value={formData.role}
                    onChange={(e) => setFormData({ ...formData, role: e.target.value as any })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-blue-500"
                  >
                    <option value="agent">Agent</option>
                    <option value="manager">Manager</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">Extension (Optional)</label>
                  <div className="relative">
                    <Hash className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      placeholder="Auto (e.g. 101)"
                      value={formData.extension}
                      onChange={(e) => setFormData({ ...formData, extension: e.target.value })}
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-9 pr-3 py-2 text-xs text-slate-100 font-mono focus:outline-none focus:border-blue-500"
                    />
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setIsAddModalOpen(false)}
                  disabled={isCreating}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  disabled={isCreating}
                  className="bg-blue-600 hover:bg-blue-500 font-semibold"
                >
                  {isCreating ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Creating...</span>
                    </>
                  ) : (
                    <span>Create User</span>
                  )}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Success Credentials Modal */}
      {createdUserResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-md p-4 animate-in fade-in duration-200">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl w-full max-w-md p-6 relative">
            <div className="flex items-center gap-2.5 mb-4">
              <div className="p-2 rounded-xl bg-emerald-600/10 border border-emerald-500/20 text-emerald-400">
                <Check className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-100">User Created Successfully</h3>
                <p className="text-xs text-slate-400">Share temporary credentials with team member</p>
              </div>
            </div>

            <div className="bg-slate-950 p-4 rounded-xl border border-slate-800/80 space-y-2 mb-5 text-xs font-mono">
              <div className="flex justify-between border-b border-slate-800 pb-1.5">
                <span className="text-slate-400">Name:</span>
                <span className="text-slate-200 font-bold">{createdUserResult.fullName}</span>
              </div>
              <div className="flex justify-between border-b border-slate-800 pb-1.5">
                <span className="text-slate-400">Login Email:</span>
                <span className="text-blue-400 font-bold">{createdUserResult.email}</span>
              </div>
              <div className="flex justify-between border-b border-slate-800 pb-1.5">
                <span className="text-slate-400">Temp Password:</span>
                <span className="text-emerald-400 font-bold">{createdUserResult.password}</span>
              </div>
              <div className="flex justify-between border-b border-slate-800 pb-1.5">
                <span className="text-slate-400">Assigned Ext:</span>
                <span className="text-slate-200">{createdUserResult.extension}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Twilio Identity:</span>
                <span className="text-slate-300">{createdUserResult.twilioIdentity}</span>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <Button
                variant="primary"
                size="md"
                onClick={handleCopyCredentials}
                className="w-full font-semibold bg-emerald-600 hover:bg-emerald-500"
              >
                {isCopied ? (
                  <>
                    <Check className="w-4 h-4" />
                    <span>Copied to Clipboard!</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-4 h-4" />
                    <span>Copy Login Details</span>
                  </>
                )}
              </Button>
              <Button
                variant="outline"
                size="md"
                onClick={() => setCreatedUserResult(null)}
              >
                Done
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
