import React from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Avatar } from '@/components/ui/Avatar';
import { ShieldCheck, UserPlus, Phone, Shield, Mail, CheckCircle2, Lock } from 'lucide-react';

export default function AdminPage() {
  const users = [
    {
      id: 'u1',
      name: 'Alex Smith',
      email: 'alex.smith@company.internal',
      role: 'admin' as const,
      status: 'online' as const,
      twilioIdentity: 'agent_alex_smith',
    },
    {
      id: 'u2',
      name: 'Sarah Jenkins',
      email: 'sarah.jenkins@company.internal',
      role: 'agent' as const,
      status: 'online' as const,
      twilioIdentity: 'agent_sarah_j',
    },
    {
      id: 'u3',
      name: 'David Miller',
      email: 'david.miller@company.internal',
      role: 'agent' as const,
      status: 'offline' as const,
      twilioIdentity: 'agent_david_m',
    },
  ];

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <h1 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <span>Administration & Team Management</span>
            <Badge variant="purple" size="md">
              ADMIN ACCESS
            </Badge>
          </h1>
          <p className="text-xs text-slate-400">Manage internal team agents, role assignments, and Twilio phone numbers.</p>
        </div>
        <Button variant="primary" size="md">
          <UserPlus className="w-4 h-4" />
          <span>Invite Team Agent</span>
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* User Roles & Agents List */}
        <div className="lg:col-span-2 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-purple-400" />
                <span>Authorized Staff Members</span>
              </CardTitle>
            </CardHeader>
            <div className="divide-y divide-slate-800">
              {users.map((user) => (
                <div key={user.id} className="py-3 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Avatar name={user.name} status={user.status} size="md" />
                    <div>
                      <p className="text-xs font-bold text-slate-100 flex items-center gap-2">
                        <span>{user.name}</span>
                        {user.role === 'admin' && (
                          <Badge variant="purple" size="sm">
                            ADMIN
                          </Badge>
                        )}
                      </p>
                      <p className="text-[10px] text-slate-400">{user.email}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-mono text-slate-500">{user.twilioIdentity}</span>
                    <Button variant="ghost" size="sm">
                      Edit Role
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>

        {/* Assigned Telephony Numbers Overview */}
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                <Phone className="w-4 h-4 text-emerald-400" />
                <span>Twilio Numbers</span>
              </CardTitle>
            </CardHeader>
            <div className="space-y-3">
              <div className="p-3 rounded-xl bg-slate-950/80 border border-slate-800 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-mono font-bold text-slate-200">+1 (800) 555-0199</span>
                  <Badge variant="emerald" size="sm">
                    PRIMARY
                  </Badge>
                </div>
                <p className="text-[10px] text-slate-400">Voice & SMS Enabled</p>
              </div>
            </div>
          </Card>

          <Card className="bg-slate-900/40">
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <Lock className="w-4 h-4 text-blue-400 shrink-0" />
              <span>Public signup disabled. New users created by Admin only.</span>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
