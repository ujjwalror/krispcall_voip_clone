import React from 'react';
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
  Mic,
  ArrowUpRight,
  TrendingUp,
  Clock,
  ShieldCheck,
} from 'lucide-react';
import Link from 'next/link';

export default function DashboardPage() {
  const stats = [
    { title: 'Total Calls Today', value: '48', change: '+12%', icon: PhoneCall, variant: 'blue' as const },
    { title: 'Missed Calls', value: '3', change: 'Action Required', icon: PhoneMissed, variant: 'rose' as const },
    { title: 'Messages Handled', value: '124', change: '+18%', icon: MessageSquare, variant: 'emerald' as const },
    { title: 'Active Agents Online', value: '6 / 8', change: '75% Capacity', icon: Users, variant: 'purple' as const },
  ];

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
          <Link href="/phone">
            <Button variant="primary" size="md">
              <PhoneCall className="w-4 h-4" />
              <span>Open Dialer</span>
            </Button>
          </Link>
          <Link href="/calls">
            <Button variant="secondary" size="md">
              <span>View Call History</span>
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
                <span>Recent Team Activity</span>
              </CardTitle>
              <Link href="/calls" className="text-xs text-blue-400 hover:underline flex items-center gap-1">
                <span>View all</span>
                <ArrowUpRight className="w-3 h-3" />
              </Link>
            </CardHeader>

            <div className="space-y-3">
              <div className="flex items-center justify-between p-3 rounded-lg bg-slate-950/60 border border-slate-800/80">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-400">
                    <PhoneIncoming className="w-4 h-4" />
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-slate-200">Inbound Call from Acme Corp (+1 555-0144)</p>
                    <p className="text-[10px] text-slate-400">Handled by Sarah Jenkins • 04:12 mins</p>
                  </div>
                </div>
                <span className="text-[11px] text-slate-400 font-mono">10 mins ago</span>
              </div>

              <div className="flex items-center justify-between p-3 rounded-lg bg-slate-950/60 border border-slate-800/80">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-rose-500/10 text-rose-400">
                    <PhoneMissed className="w-4 h-4" />
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-slate-200">Missed Call from Tech Solutions (+1 555-0188)</p>
                    <p className="text-[10px] text-rose-400">Unanswered • Needs Follow-up</p>
                  </div>
                </div>
                <span className="text-[11px] text-slate-400 font-mono">24 mins ago</span>
              </div>

              <div className="flex items-center justify-between p-3 rounded-lg bg-slate-950/60 border border-slate-800/80">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-blue-500/10 text-blue-400">
                    <PhoneOutgoing className="w-4 h-4" />
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-slate-200">Outbound Call to Global Freight (+1 555-0199)</p>
                    <p className="text-[10px] text-slate-400">Handled by Alex Smith • 08:45 mins</p>
                  </div>
                </div>
                <span className="text-[11px] text-slate-400 font-mono">1 hour ago</span>
              </div>
            </div>
          </Card>

          {/* System Security & Configuration Summary */}
          <Card className="bg-slate-900/40">
            <div className="flex items-center gap-3">
              <ShieldCheck className="w-5 h-5 text-emerald-400 shrink-0" />
              <div>
                <h4 className="text-xs font-semibold text-slate-200">Internal Security & Credentials Isolation</h4>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  Twilio credentials and Supabase database keys are isolated in server routes. No private API tokens are exposed to browser clients.
                </p>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
