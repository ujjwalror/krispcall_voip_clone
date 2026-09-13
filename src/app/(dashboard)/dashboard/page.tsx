'use client';

import React, { useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DialerWidget } from '@/components/dialer/DialerWidget';
import {
  PhoneCall,
  PhoneIncoming,
  PhoneOutgoing,
  PhoneMissed,
  MessageSquare,
  Users,
  ArrowUpRight,
  Clock,
  ShieldCheck,
  RefreshCw,
} from 'lucide-react';
import Link from 'next/link';
import { CallRepository, CallWithProfile } from '@/lib/repositories/call.repository';
import { useAuth } from '@/components/providers/AuthProvider';
import { formatDuration, formatCallTime } from '@/lib/utils';

export default function DashboardPage() {
  const [calls, setCalls] = useState<CallWithProfile[]>([]);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [missedCount, setMissedCount] = useState<number>(0);
  const [activeAgentsCount, setActiveAgentsCount] = useState<number>(0);
  const [messagesCount, setMessagesCount] = useState<number>(0);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  const { profile } = useAuth();
  const callRepo = new CallRepository();

  const loadDashboardData = async () => {
    setIsLoading(true);
    try {
      const orgId = profile?.organization_id;
      const [fetchedCalls, total, missed, activeAgents, messages] = await Promise.all([
        callRepo.getCalls(orgId, 5),
        callRepo.getTotalCallsCount(orgId),
        callRepo.getMissedInboundCallsCount(orgId),
        callRepo.getActiveAgentsCount(orgId),
        callRepo.getMessagesCount(orgId),
      ]);

      setCalls(fetchedCalls);
      setTotalCount(total);
      setMissedCount(missed);
      setActiveAgentsCount(activeAgents);
      setMessagesCount(messages);
    } catch (err) {
      console.error('Error loading dashboard data:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (profile?.organization_id) {
      loadDashboardData();
    } else {
      setIsLoading(false);
    }
  }, [profile?.organization_id]);

  const stats = [
    {
      title: 'Total Workspace Calls',
      value: totalCount.toString(),
      change: 'Real-time',
      icon: PhoneCall,
      variant: 'blue' as const,
    },
    {
      title: 'Missed / Unhandled Calls',
      value: missedCount.toString(),
      change: missedCount > 0 ? 'Needs Follow-up' : 'All Clear',
      icon: PhoneMissed,
      variant: (missedCount > 0 ? 'rose' : 'emerald') as 'rose' | 'emerald',
    },
    {
      title: 'Messages Handled',
      value: messagesCount.toString(),
      change: 'SMS Module',
      icon: MessageSquare,
      variant: 'emerald' as const,
    },
    {
      title: 'Active Agents Online',
      value: `${activeAgentsCount} Active`,
      change: activeAgentsCount > 0 ? 'Capacity OK' : 'Offline',
      icon: Users,
      variant: (activeAgentsCount > 0 ? 'purple' : 'neutral') as 'purple' | 'neutral',
    },
  ];

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'completed':
      case 'answered':
        return <Badge variant="emerald" size="sm">COMPLETED</Badge>;
      case 'in-progress':
        return <Badge variant="blue" pulse size="sm">IN CALL</Badge>;
      case 'no-answer':
        return <Badge variant="rose" size="sm">NO ANSWER</Badge>;
      case 'busy':
        return <Badge variant="rose" size="sm">BUSY</Badge>;
      case 'failed':
        return <Badge variant="rose" size="sm">FAILED</Badge>;
      case 'canceled':
        return <Badge variant="neutral" size="sm">CANCELED</Badge>;
      case 'ringing':
        return <Badge variant="amber" pulse size="sm">RINGING</Badge>;
      case 'initiated':
        return <Badge variant="blue" pulse size="sm">INITIATED</Badge>;
      default:
        return <Badge variant="neutral" size="sm">{status ? status.toUpperCase() : 'UNKNOWN'}</Badge>;
    }
  };

  return (
    <div className="space-y-6">
      {/* Welcome Banner */}
      <div className="rounded-2xl bg-gradient-to-r from-blue-900/40 via-indigo-900/30 to-slate-900 border border-blue-500/20 p-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 shadow-xl">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-slate-100">Internal Telecom Dashboard</h1>
            <Badge variant="blue" pulse size="sm">
              SYSTEM ONLINE
            </Badge>
          </div>
          <p className="text-xs text-slate-400">
            Internal VoIP operations center. WebRTC browser calling & Twilio telephony backend ready.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={loadDashboardData} disabled={isLoading}>
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </Button>
          <Link href="/phone">
            <Button variant="primary" size="md">
              <PhoneCall className="w-4 h-4" />
              <span>Open Dialer</span>
            </Button>
          </Link>
        </div>
      </div>

      {/* Metrics Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <Card key={stat.title} hoverable>
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-slate-400">{stat.title}</span>
                <div className="p-2 rounded-lg bg-slate-800/80 text-slate-300">
                  <Icon className="w-4 h-4" />
                </div>
              </div>
              <div className="mt-3 flex items-baseline justify-between">
                <span className="text-2xl font-bold text-slate-100 tracking-tight">{stat.value}</span>
                <Badge variant={stat.variant} size="sm">
                  {stat.change}
                </Badge>
              </div>
            </Card>
          );
        })}
      </div>

      {/* Workspace Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Quick Launcher Dialer Widget */}
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
            <PhoneCall className="w-4 h-4 text-blue-400" />
            <span>Browser WebRTC Dialer</span>
          </h3>
          <DialerWidget />
        </div>

        {/* Activity Feed & Team Overview */}
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                <Clock className="w-4 h-4 text-indigo-400" />
                <span>Recent Calls & Activity</span>
              </CardTitle>
              <Link href="/calls" className="text-xs text-blue-400 hover:underline flex items-center gap-1">
                <span>View all</span>
                <ArrowUpRight className="w-3 h-3" />
              </Link>
            </CardHeader>

            <div className="space-y-3">
              {calls.length === 0 ? (
                <div className="p-6 text-center text-xs text-slate-500 rounded-lg bg-slate-950/40 border border-slate-800/50">
                  No call records found yet. Place an outbound call from the dialer to get started.
                </div>
              ) : (
                calls.map((call) => {
                  const isOutbound = call.direction === 'outbound';
                  const isMissed = ['no-answer', 'busy', 'failed', 'canceled'].includes(call.status);
                  const agentName = call.profiles?.full_name || 'Agent';

                  return (
                    <div
                      key={call.id}
                      className="flex items-center justify-between p-3 rounded-lg bg-slate-950/60 border border-slate-800/80 hover:border-slate-700 transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <div
                          className={`p-2 rounded-lg ${
                            isMissed
                              ? 'bg-rose-500/10 text-rose-400'
                              : isOutbound
                              ? 'bg-blue-500/10 text-blue-400'
                              : 'bg-emerald-500/10 text-emerald-400'
                          }`}
                        >
                          {isMissed ? (
                            <PhoneMissed className="w-4 h-4" />
                          ) : isOutbound ? (
                            <PhoneOutgoing className="w-4 h-4" />
                          ) : (
                            <PhoneIncoming className="w-4 h-4" />
                          )}
                        </div>
                        <div>
                          <p className="text-xs font-semibold text-slate-200">
                            {isOutbound ? `To: ${call.to_number}` : `From: ${call.from_number}`}
                          </p>
                          <p className="text-[10px] text-slate-400">
                            Agent: {agentName} • Duration: {formatDuration(call.duration_seconds || 0)}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-3">
                        {getStatusBadge(call.status)}
                        <span className="text-[11px] text-slate-400 font-mono">
                          {formatCallTime(call.created_at, profile?.timezone, profile?.time_format)}
                        </span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </Card>

          {/* System Security Summary */}
          <Card className="bg-slate-900/40">
            <div className="flex items-center gap-3">
              <ShieldCheck className="w-5 h-5 text-emerald-400 shrink-0" />
              <div>
                <h4 className="text-xs font-semibold text-slate-200">Call Logging & Database Protection</h4>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  Call records and status callbacks are securely synchronized with PostgreSQL Row Level Security (RLS).
                </p>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
