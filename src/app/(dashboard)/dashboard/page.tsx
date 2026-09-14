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
      {/* Modern Enterprise SaaS Hero Card */}
      <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 border-t-4 border-t-blue-600 dark:border-t-blue-500 p-4 sm:p-6 flex flex-col md:flex-row items-start md:items-center justify-between gap-4 shadow-sm dark:shadow-xl transition-all w-full">
        <div className="space-y-1.5 max-w-2xl w-full">
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <h1 className="text-lg sm:text-2xl font-extrabold text-slate-900 dark:text-slate-100 tracking-tight leading-snug">
              Internal Telecom Dashboard
            </h1>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-950/80 text-emerald-800 dark:text-emerald-300 font-bold text-[11px] border border-emerald-200 dark:border-emerald-800/80 shadow-xs shrink-0">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </span>
              <span>SYSTEM ONLINE</span>
            </span>
          </div>
          <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-400 font-medium leading-relaxed">
            Internal VoIP operations center. WebRTC browser calling & Twilio telephony backend ready.
          </p>
        </div>
        <div className="flex items-center gap-2.5 w-full md:w-auto shrink-0 pt-1 md:pt-0">
          <button
            onClick={loadDashboardData}
            disabled={isLoading}
            className="flex-1 md:flex-none inline-flex items-center justify-center gap-1.5 px-3.5 py-2.5 rounded-xl bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 font-semibold text-xs border border-slate-200 dark:border-slate-700 shadow-xs hover:bg-slate-50 dark:hover:bg-slate-700 hover:text-slate-900 transition-all disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 text-slate-500 dark:text-slate-400 ${isLoading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
          <Link
            href="/phone"
            className="flex-1 md:flex-none inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-500 text-white font-semibold text-xs shadow-md shadow-blue-600/20 transition-all active:scale-[0.98]"
          >
            <PhoneCall className="w-4 h-4" />
            <span>Open Dialer</span>
          </Link>
        </div>
      </div>

      {/* Metrics Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 w-full">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <Card key={stat.title} hoverable>
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-slate-500 dark:text-slate-400">{stat.title}</span>
                <div className="p-2 rounded-lg bg-slate-100 dark:bg-slate-800/80 text-slate-700 dark:text-slate-300">
                  <Icon className="w-4 h-4" />
                </div>
              </div>
              <div className="mt-3 flex items-baseline justify-between">
                <span className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-slate-100 tracking-tight">{stat.value}</span>
                <Badge variant={stat.variant} size="sm">
                  {stat.change}
                </Badge>
              </div>
            </Card>
          );
        })}
      </div>

      {/* Workspace Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 w-full">
        {/* Quick Launcher Dialer Widget */}
        <div className="space-y-4 w-full">
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-2">
            <PhoneCall className="w-4 h-4 text-blue-500" />
            <span>Browser WebRTC Dialer</span>
          </h3>
          <DialerWidget />
        </div>

        {/* Activity Feed & Team Overview */}
        <div className="lg:col-span-2 space-y-6 w-full">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                <Clock className="w-4 h-4 text-indigo-500" />
                <span>Recent Calls & Activity</span>
              </CardTitle>
              <Link href="/calls" className="text-xs text-blue-500 hover:underline flex items-center gap-1">
                <span>View all</span>
                <ArrowUpRight className="w-3 h-3" />
              </Link>
            </CardHeader>

            <div className="space-y-3">
              {calls.length === 0 ? (
                <div className="p-6 text-center text-xs text-slate-500 rounded-lg bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800/50">
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
                      className="flex flex-col sm:flex-row sm:items-center justify-between p-3 rounded-xl bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800/80 hover:border-slate-300 dark:hover:border-slate-700 transition-colors gap-2.5"
                    >
                      <div className="flex items-center gap-3">
                        <div
                          className={`p-2 rounded-lg shrink-0 ${
                            isMissed
                              ? 'bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400'
                              : isOutbound
                              ? 'bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400'
                              : 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
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
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-slate-900 dark:text-slate-200 truncate">
                            {isOutbound ? `To: ${call.to_number}` : `From: ${call.from_number}`}
                          </p>
                          <p className="text-[10px] text-slate-500 dark:text-slate-400 truncate">
                            Agent: {agentName} • Duration: {formatDuration(call.duration_seconds || 0)}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center justify-between sm:justify-end gap-3 shrink-0 pt-1 sm:pt-0 border-t sm:border-t-0 border-slate-200/60 dark:border-slate-800/60">
                        {getStatusBadge(call.status)}
                        <span className="text-[11px] text-slate-500 dark:text-slate-400 font-mono">
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
          <Card className="bg-slate-50 dark:bg-slate-900/40">
            <div className="flex items-center gap-3">
              <ShieldCheck className="w-5 h-5 text-emerald-500 shrink-0" />
              <div>
                <h4 className="text-xs font-semibold text-slate-900 dark:text-slate-200">Call Logging & Database Protection</h4>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
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
