'use client';

import React, { useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Users, ShieldCheck, UserCheck, PhoneCall, RefreshCw, Save, Circle, Layers } from 'lucide-react';

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

export default function WorkspaceUsersPage() {
  const [members, setMembers] = useState<Member[]>([]);
  const [routingStrategy, setRoutingStrategy] = useState<'ring_all' | 'round_robin'>('ring_all');
  const [currentUserRole, setCurrentUserRole] = useState<string>('agent');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);

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
      }
    } catch (err) {
      console.error('[WorkspaceUsersPage] Update failed:', err);
    } finally {
      setIsSaving(false);
      setEditingUserId(null);
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

        <Button variant="outline" size="sm" onClick={loadWorkspaceData} disabled={isLoading}>
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          <span>Refresh Team</span>
        </Button>
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
              <Card key={member.id} className="p-4 bg-slate-900/60 border border-slate-800 hover:border-slate-700/80 transition-all rounded-xl">
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
                        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-950 border border-slate-800 text-[10px] text-slate-400 font-mono">
                          <Circle className={`w-2 h-2 fill-current ${presence.color}`} />
                          {presence.label}
                        </span>
                      </div>
                      <p className="text-xs text-slate-400 font-mono mt-0.5">
                        {member.email} • Ext: <span className="text-blue-400">{member.extension || '101'}</span> • Identity: <span className="text-slate-300">{member.twilio_identity}</span>
                      </p>
                    </div>
                  </div>

                  {/* Actions / Edit Form */}
                  {canManage && (
                    <div className="flex items-center gap-3 bg-slate-950/80 p-2 rounded-xl border border-slate-800/80">
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
                        placeholder="Ext (101)"
                        defaultValue={member.extension || ''}
                        onBlur={(e) => handleUpdateMember(member.id, { extension: e.target.value })}
                        className="w-16 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-200 font-mono text-center focus:outline-none"
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
    </div>
  );
}
