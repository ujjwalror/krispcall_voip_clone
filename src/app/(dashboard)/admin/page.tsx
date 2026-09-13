'use client';

import React, { useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Avatar } from '@/components/ui/Avatar';
import { ShieldCheck, UserPlus, Phone, Lock, RefreshCw, CheckCircle2, Globe } from 'lucide-react';
import { formatDisplayPhoneNumber } from '@/lib/utils';

export interface BusinessPhoneNumber {
  id: string;
  phone_number: string;
  friendly_name?: string;
  active: boolean;
  is_primary?: boolean;
  created_at?: string;
}

export default function AdminPage() {
  const [phoneNumbers, setPhoneNumbers] = useState<BusinessPhoneNumber[]>([]);
  const [isLoadingNumbers, setIsLoadingNumbers] = useState(true);

  const users = [
    {
      id: 'u1',
      name: 'Alex Smith',
      email: 'alex.smith@company.internal',
      role: 'admin' as const,
      status: 'online' as const,
      identity: 'agent_alex_smith',
    },
    {
      id: 'u2',
      name: 'Sarah Jenkins',
      email: 'sarah.jenkins@company.internal',
      role: 'agent' as const,
      status: 'online' as const,
      identity: 'agent_sarah_j',
    },
    {
      id: 'u3',
      name: 'David Miller',
      email: 'david.miller@company.internal',
      role: 'agent' as const,
      status: 'offline' as const,
      identity: 'agent_david_m',
    },
  ];

  const fetchBusinessNumbers = async () => {
    setIsLoadingNumbers(true);
    try {
      const res = await fetch('/api/phone-numbers');
      if (res.ok) {
        const data = await res.json();
        setPhoneNumbers(data.phoneNumbers || []);
      }
    } catch (err) {
      console.error('Error loading business numbers:', err);
    } finally {
      setIsLoadingNumbers(false);
    }
  };

  useEffect(() => {
    fetchBusinessNumbers();
  }, []);

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <h1 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <span>Administration & Team Management</span>
            <Badge variant="purple" size="md">
              ADMIN ACCESS
            </Badge>
          </h1>
          <p className="text-xs text-slate-400">
            Manage internal team agents, role assignments, and organization business numbers.
          </p>
        </div>
        <Button variant="primary" size="md">
          <UserPlus className="w-4 h-4" />
          <span>Invite Team Agent</span>
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* User Roles & Staff Members */}
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
                    <span className="text-[10px] font-mono text-slate-500">ID: {user.identity}</span>
                    <Button variant="ghost" size="sm">
                      Edit Role
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>

        {/* Provider-Neutral Business Numbers Overview */}
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between w-full">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Phone className="w-4 h-4 text-emerald-400" />
                  <span>Business Numbers</span>
                </CardTitle>
                <button
                  onClick={fetchBusinessNumbers}
                  className="text-slate-400 hover:text-slate-200 transition-colors p-1"
                  title="Refresh business numbers"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isLoadingNumbers ? 'animate-spin text-blue-400' : ''}`} />
                </button>
              </div>
            </CardHeader>

            <div className="space-y-3">
              {isLoadingNumbers ? (
                <div className="p-4 text-center text-xs text-slate-400">
                  <RefreshCw className="w-4 h-4 animate-spin mx-auto mb-1.5 text-emerald-400" />
                  <span>Loading business lines...</span>
                </div>
              ) : phoneNumbers.length === 0 ? (
                <div className="p-4 text-center text-xs text-slate-500">
                  No active business numbers configured.
                </div>
              ) : (
                phoneNumbers.map((num, idx) => {
                  const formatted = formatDisplayPhoneNumber(num.phone_number);
                  const isPrimary = Boolean(num.is_primary) || idx === 0;

                  return (
                    <div
                      key={num.id || num.phone_number}
                      className="p-3.5 rounded-xl bg-slate-950/80 border border-slate-800 space-y-2 hover:border-slate-700 transition-colors"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-mono font-bold text-slate-100 tracking-wide">
                          {formatted}
                        </span>
                        {isPrimary && (
                          <Badge variant="emerald" size="sm">
                            PRIMARY
                          </Badge>
                        )}
                      </div>

                      <div className="flex items-center justify-between text-[11px] text-slate-400 border-t border-slate-800/60 pt-2">
                        <span className="flex items-center gap-1 text-slate-300">
                          <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />
                          <span>Incoming & Outgoing</span>
                        </span>
                        <span className="text-[10px] text-slate-500">
                          {num.friendly_name || 'Business Line'}
                        </span>
                      </div>

                      <p className="text-[10px] text-slate-400">
                        Used for incoming and outgoing calls
                      </p>
                    </div>
                  );
                })
              )}
            </div>
          </Card>

          <Card className="bg-slate-900/40">
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <Lock className="w-4 h-4 text-blue-400 shrink-0" />
              <span>Public signup disabled. Workspace numbers and users are managed by Admin.</span>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
