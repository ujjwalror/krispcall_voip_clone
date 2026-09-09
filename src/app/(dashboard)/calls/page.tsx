import React from 'react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Avatar } from '@/components/ui/Avatar';
import {
  PhoneIncoming,
  PhoneOutgoing,
  PhoneMissed,
  Search,
  Filter,
  Play,
  PhoneCall,
  Download,
  Clock,
} from 'lucide-react';
import { formatDuration } from '@/lib/utils';

export default function CallsPage() {
  const callLogs = [
    {
      id: 'call_1',
      direction: 'inbound' as const,
      fromNumber: '+1 (555) 014-4321',
      toNumber: '+1 (800) 555-0199',
      contactName: 'Acme Corp (John Doe)',
      duration: 252,
      status: 'completed' as const,
      timestamp: '2026-09-09T10:15:00Z',
      agentName: 'Sarah Jenkins',
      hasRecording: true,
    },
    {
      id: 'call_2',
      direction: 'outbound' as const,
      fromNumber: '+1 (800) 555-0199',
      toNumber: '+1 (555) 019-8821',
      contactName: 'Cyberdyne Systems',
      duration: 525,
      status: 'completed' as const,
      timestamp: '2026-09-09T09:40:00Z',
      agentName: 'Alex Smith',
      hasRecording: true,
    },
    {
      id: 'call_3',
      direction: 'inbound' as const,
      fromNumber: '+1 (555) 012-9900',
      toNumber: '+1 (800) 555-0199',
      contactName: 'Tech Solutions LLC',
      duration: 0,
      status: 'missed' as const,
      timestamp: '2026-09-09T09:12:00Z',
      agentName: 'Unassigned',
      hasRecording: false,
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header & Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <h1 className="text-xl font-bold text-slate-100">Call History</h1>
          <p className="text-xs text-slate-400">Complete record of inbound, outbound, and missed team calls.</p>
        </div>
        <div className="flex items-center gap-3">
          <Input icon={<Search className="w-4 h-4" />} placeholder="Filter by number or contact..." className="w-64" />
          <Button variant="outline" size="md">
            <Filter className="w-4 h-4" />
            <span>Filter</span>
          </Button>
        </div>
      </div>

      {/* Call History Table Container */}
      <Card className="p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="bg-slate-950/80 text-slate-400 uppercase font-semibold text-[10px] tracking-wider border-b border-slate-800">
              <tr>
                <th className="px-5 py-3.5">Type & Contact</th>
                <th className="px-5 py-3.5">Phone Number</th>
                <th className="px-5 py-3.5">Agent Handled</th>
                <th className="px-5 py-3.5">Duration</th>
                <th className="px-5 py-3.5">Date / Time</th>
                <th className="px-5 py-3.5">Recording</th>
                <th className="px-5 py-3.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {callLogs.map((log) => (
                <tr key={log.id} className="hover:bg-slate-800/40 transition-colors">
                  <td className="px-5 py-4">
                    <div className="flex items-center gap-3">
                      {log.direction === 'inbound' ? (
                        log.status === 'missed' ? (
                          <div className="p-2 rounded-lg bg-rose-500/10 text-rose-400">
                            <PhoneMissed className="w-4 h-4" />
                          </div>
                        ) : (
                          <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-400">
                            <PhoneIncoming className="w-4 h-4" />
                          </div>
                        )
                      ) : (
                        <div className="p-2 rounded-lg bg-blue-500/10 text-blue-400">
                          <PhoneOutgoing className="w-4 h-4" />
                        </div>
                      )}
                      <div>
                        <p className="font-semibold text-slate-100">{log.contactName}</p>
                        <p className="text-[10px] text-slate-400 uppercase font-mono">{log.direction} Call</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-4 font-mono text-slate-300">{log.fromNumber}</td>
                  <td className="px-5 py-4">
                    <div className="flex items-center gap-2">
                      <Avatar name={log.agentName} size="sm" />
                      <span className="font-medium text-slate-200">{log.agentName}</span>
                    </div>
                  </td>
                  <td className="px-5 py-4 font-mono">
                    {log.duration > 0 ? (
                      <span className="text-slate-200">{formatDuration(log.duration)}</span>
                    ) : (
                      <span className="text-rose-400 font-semibold">00:00</span>
                    )}
                  </td>
                  <td className="px-5 py-4 text-slate-400">
                    {new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </td>
                  <td className="px-5 py-4">
                    {log.hasRecording ? (
                      <Badge variant="blue" size="sm">
                        <Play className="w-2.5 h-2.5 fill-current" />
                        Audio Saved
                      </Badge>
                    ) : (
                      <span className="text-slate-600 text-[10px]">No recording</span>
                    )}
                  </td>
                  <td className="px-5 py-4 text-right">
                    <Button variant="ghost" size="sm" className="text-blue-400 hover:text-blue-300">
                      <PhoneCall className="w-3.5 h-3.5" />
                      <span>Call</span>
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
