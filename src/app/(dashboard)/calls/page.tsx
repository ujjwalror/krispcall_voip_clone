'use client';

import React, { useEffect, useState, useCallback } from 'react';
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
  PhoneCall,
  RefreshCw,
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Ban,
} from 'lucide-react';
import { formatDuration, formatCallTime, normalizeE164PhoneNumber } from '@/lib/utils';
import { CallRepository, CallWithProfile } from '@/lib/repositories/call.repository';
import { useAuth } from '@/components/providers/AuthProvider';
import { BlockNumberConfirmationModal } from '@/components/call/BlockNumberConfirmationModal';
import Link from 'next/link';

export default function CallsPage() {
  const [calls, setCalls] = useState<CallWithProfile[]>([]);
  const [blockedNumbersMap, setBlockedNumbersMap] = useState<Record<string, boolean>>({});
  const [directionFilter, setDirectionFilter] = useState<'all' | 'inbound' | 'outbound'>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'completed' | 'missed' | 'failed'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  // Modal state for direct call history blocking
  const [blockingPhone, setBlockingPhone] = useState<string | null>(null);

  const { profile } = useAuth();
  const callRepo = new CallRepository();

  const loadBlockedNumbers = useCallback(async () => {
    try {
      const res = await fetch('/api/blocked-numbers');
      if (res.ok) {
        const data = await res.json();
        const map: Record<string, boolean> = {};
        (data.blockedNumbers || []).forEach((b: any) => {
          if (b.normalized_phone) {
            map[b.normalized_phone] = true;
          }
        });
        setBlockedNumbersMap(map);
      }
    } catch (err) {
      console.error('Error fetching blocked numbers map:', err);
    }
  }, []);

  const loadCalls = useCallback(async () => {
    setIsLoading(true);
    try {
      const [results] = await Promise.all([
        callRepo.getFilteredCalls({
          organizationId: profile?.organization_id,
          direction: directionFilter,
          status: statusFilter,
          search: searchQuery,
          limit: 100,
        }),
        loadBlockedNumbers(),
      ]);
      setCalls(results);
    } catch (err) {
      console.error('Error loading calls:', err);
    } finally {
      setIsLoading(false);
    }
  }, [profile?.organization_id, directionFilter, statusFilter, searchQuery, loadBlockedNumbers]);

  useEffect(() => {
    loadCalls();
  }, [loadCalls]);

  const handleUnblockPhone = async (phone: string) => {
    try {
      const res = await fetch(`/api/blocked-numbers`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      });
      if (res.ok) {
        loadCalls();
      }
    } catch (err) {
      console.error('Error unblocking phone:', err);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'completed':
      case 'answered':
        return (
          <Badge variant="emerald" size="sm">
            <CheckCircle2 className="w-2.5 h-2.5" />
            COMPLETED
          </Badge>
        );
      case 'in-progress':
        return (
          <Badge variant="blue" pulse size="sm">
            <PhoneCall className="w-2.5 h-2.5" />
            IN CALL
          </Badge>
        );
      case 'no-answer':
        return (
          <Badge variant="rose" size="sm">
            <PhoneMissed className="w-2.5 h-2.5" />
            NO ANSWER
          </Badge>
        );
      case 'busy':
        return (
          <Badge variant="rose" size="sm">
            <XCircle className="w-2.5 h-2.5" />
            BUSY
          </Badge>
        );
      case 'failed':
        return (
          <Badge variant="rose" size="sm">
            <AlertTriangle className="w-2.5 h-2.5" />
            FAILED
          </Badge>
        );
      case 'blocked':
        return (
          <Badge variant="rose" size="sm">
            <Ban className="w-2.5 h-2.5" />
            BLOCKED
          </Badge>
        );
      case 'canceled':
        return (
          <Badge variant="neutral" size="sm">
            CANCELED
          </Badge>
        );
      case 'ringing':
        return (
          <Badge variant="amber" pulse size="sm">
            RINGING
          </Badge>
        );
      case 'initiated':
        return (
          <Badge variant="blue" pulse size="sm">
            INITIATED
          </Badge>
        );
      default:
        return <Badge variant="neutral" size="sm">{status ? status.toUpperCase() : 'UNKNOWN'}</Badge>;
    }
  };

  return (
    <div className="space-y-6">
      {/* Header & Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <h1 className="text-xl font-bold text-slate-100">Call History & Logs</h1>
          <p className="text-xs text-slate-400">
            Real-time call logs with direct block list controls for inbound and outbound calls.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={loadCalls} disabled={isLoading}>
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </Button>
          <Link href="/phone">
            <Button variant="primary" size="md">
              <PhoneCall className="w-4 h-4" />
              <span>Make Call</span>
            </Button>
          </Link>
        </div>
      </div>

      {/* Filter Toolbar */}
      <Card className="p-4 bg-slate-900/60 border-slate-800 flex flex-wrap items-center justify-between gap-4">
        {/* Search Input */}
        <div className="relative w-full sm:w-72">
          <Input
            icon={<Search className="w-4 h-4" />}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by phone or agent..."
            className="w-full"
          />
        </div>

        {/* Filter Selectors */}
        <div className="flex items-center gap-3 w-full sm:w-auto">
          <div className="flex items-center gap-1.5">
            <Filter className="w-3.5 h-3.5 text-slate-400" />
            <span className="text-xs text-slate-400 font-medium">Direction:</span>
            <select
              value={directionFilter}
              onChange={(e: any) => setDirectionFilter(e.target.value)}
              className="bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 p-2 outline-none focus:border-blue-500"
            >
              <option value="all">All Directions</option>
              <option value="outbound">Outgoing (Outbound)</option>
              <option value="inbound">Incoming (Inbound)</option>
            </select>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-xs text-slate-400 font-medium">Status:</span>
            <select
              value={statusFilter}
              onChange={(e: any) => setStatusFilter(e.target.value)}
              className="bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 p-2 outline-none focus:border-blue-500"
            >
              <option value="all">All Statuses</option>
              <option value="completed">Completed</option>
              <option value="missed">Missed / No Answer</option>
              <option value="failed">Failed</option>
            </select>
          </div>
        </div>
      </Card>

      {/* Call History Container (Table on Desktop, Cards on Mobile) */}
      <Card className="p-0 overflow-hidden">
        {/* Desktop Table View */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="bg-slate-950/80 text-slate-400 uppercase font-semibold text-[10px] tracking-wider border-b border-slate-800">
              <tr>
                <th className="px-5 py-3.5">Direction & Number</th>
                <th className="px-5 py-3.5">Agent / User</th>
                <th className="px-5 py-3.5">Status</th>
                <th className="px-5 py-3.5">Duration</th>
                <th className="px-5 py-3.5">Date / Time</th>
                <th className="px-5 py-3.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {isLoading ? (
                <tr>
                  <td colSpan={6} className="px-5 py-8 text-center text-slate-500">
                    <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2 text-blue-400" />
                    <span>Loading call history from database...</span>
                  </td>
                </tr>
              ) : calls.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-5 py-8 text-center text-slate-500">
                    No calls match the selected criteria.
                  </td>
                </tr>
              ) : (
                calls.map((log) => {
                  const isOutbound = log.direction === 'outbound';
                  const targetNumber = isOutbound ? log.to_number : log.from_number;
                  const normalizedTarget = normalizeE164PhoneNumber(targetNumber).normalized || targetNumber;
                  const isBlocked = Boolean(blockedNumbersMap[normalizedTarget]) || log.status === 'blocked';
                  const isMissed = ['no-answer', 'busy', 'failed', 'canceled'].includes(log.status);
                  const agentName = log.profiles?.full_name || 'Agent';

                  return (
                    <tr key={log.id} className="hover:bg-slate-800/40 transition-colors">
                      <td className="px-5 py-4">
                        <div className="flex items-center gap-3">
                          <div
                            className={`p-2 rounded-lg ${
                              log.status === 'blocked' || isBlocked
                                ? 'bg-rose-950/80 text-rose-400 border border-rose-800/80'
                                : isMissed
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
                            <div className="flex items-center gap-2">
                              <p className="font-semibold text-slate-100 font-mono">
                                {isOutbound ? `To: ${log.to_number}` : `From: ${log.from_number}`}
                              </p>
                              {isBlocked && (
                                <Badge variant="rose" size="sm">
                                  <Ban className="w-2.5 h-2.5" />
                                  BLOCKED
                                </Badge>
                              )}
                            </div>
                            <p className="text-[10px] text-slate-400 uppercase font-mono mt-0.5">
                              {log.direction} Call
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-4">
                        <div className="flex items-center gap-2">
                          <Avatar name={agentName} size="sm" />
                          <span className="font-medium text-slate-200">{agentName}</span>
                        </div>
                      </td>
                      <td className="px-5 py-4">{getStatusBadge(log.status)}</td>
                      <td className="px-5 py-4 font-mono">
                        {log.duration_seconds && log.duration_seconds > 0 ? (
                          <span className="text-slate-200">{formatDuration(log.duration_seconds)}</span>
                        ) : (
                          <span className="text-slate-500">00:00</span>
                        )}
                      </td>
                      <td className="px-5 py-4 text-slate-400">
                        {formatCallTime(log.created_at, profile?.timezone, profile?.time_format)}
                      </td>
                      <td className="px-5 py-4 text-right">
                        <div className="flex items-center justify-end gap-2">
                          {isBlocked ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-emerald-400 hover:text-emerald-300 hover:bg-emerald-950/40"
                              onClick={() => handleUnblockPhone(targetNumber)}
                            >
                              <Ban className="w-3.5 h-3.5 text-emerald-400" />
                              <span>Unblock</span>
                            </Button>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-amber-400 hover:text-amber-300 hover:bg-amber-950/40"
                              onClick={() => setBlockingPhone(targetNumber)}
                            >
                              <Ban className="w-3.5 h-3.5 text-amber-400" />
                              <span>Block Number</span>
                            </Button>
                          )}

                          <Link href={`/phone?number=${encodeURIComponent(targetNumber)}`}>
                            <Button variant="ghost" size="sm" className="text-blue-400 hover:text-blue-300">
                              <PhoneCall className="w-3.5 h-3.5" />
                              <span>Redial</span>
                            </Button>
                          </Link>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Mobile Card View */}
        <div className="block md:hidden divide-y divide-slate-800">
          {isLoading ? (
            <div className="p-8 text-center text-slate-500">
              <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2 text-blue-400" />
              <span>Loading call history...</span>
            </div>
          ) : calls.length === 0 ? (
            <div className="p-8 text-center text-slate-500">
              No calls match the selected criteria.
            </div>
          ) : (
            calls.map((log) => {
              const isOutbound = log.direction === 'outbound';
              const targetNumber = isOutbound ? log.to_number : log.from_number;
              const normalizedTarget = normalizeE164PhoneNumber(targetNumber).normalized || targetNumber;
              const isBlocked = Boolean(blockedNumbersMap[normalizedTarget]) || log.status === 'blocked';
              const isMissed = ['no-answer', 'busy', 'failed', 'canceled'].includes(log.status);
              const agentName = log.profiles?.full_name || 'Agent';

              return (
                <div key={log.id} className="p-4 space-y-3 bg-slate-900/60">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                      <div
                        className={`p-2 rounded-lg shrink-0 ${
                          log.status === 'blocked' || isBlocked
                            ? 'bg-rose-950/80 text-rose-400 border border-rose-800/80'
                            : isMissed
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
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <p className="font-semibold text-slate-100 font-mono text-sm">
                            {isOutbound ? `To: ${log.to_number}` : `From: ${log.from_number}`}
                          </p>
                          {isBlocked && (
                            <Badge variant="rose" size="sm">
                              <Ban className="w-2.5 h-2.5" />
                              BLOCKED
                            </Badge>
                          )}
                        </div>
                        <p className="text-[10px] text-slate-400 font-mono">
                          {formatCallTime(log.created_at, profile?.timezone, profile?.time_format)}
                        </p>
                      </div>
                    </div>
                    <div>{getStatusBadge(log.status)}</div>
                  </div>

                  <div className="flex items-center justify-between text-xs text-slate-400 pt-1 border-t border-slate-800/60">
                    <div className="flex items-center gap-1.5">
                      <Avatar name={agentName} size="sm" />
                      <span>{agentName}</span>
                    </div>
                    <span className="font-mono text-slate-300">
                      Duration: {log.duration_seconds && log.duration_seconds > 0 ? formatDuration(log.duration_seconds) : '00:00'}
                    </span>
                  </div>

                  <div className="flex items-center justify-end gap-2 pt-1">
                    {isBlocked ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-emerald-400 hover:bg-emerald-950/40 text-xs"
                        onClick={() => handleUnblockPhone(targetNumber)}
                      >
                        <Ban className="w-3.5 h-3.5" />
                        <span>Unblock</span>
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-amber-400 hover:bg-amber-950/40 text-xs"
                        onClick={() => setBlockingPhone(targetNumber)}
                      >
                        <Ban className="w-3.5 h-3.5" />
                        <span>Block</span>
                      </Button>
                    )}

                    <Link href={`/phone?number=${encodeURIComponent(targetNumber)}`}>
                      <Button variant="outline" size="sm" className="text-xs">
                        <PhoneCall className="w-3.5 h-3.5 text-blue-400" />
                        <span>Call Back</span>
                      </Button>
                    </Link>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </Card>

      <BlockNumberConfirmationModal
        phoneNumber={blockingPhone}
        isOpen={Boolean(blockingPhone)}
        onClose={() => setBlockingPhone(null)}
        onSuccess={loadCalls}
      />
    </div>
  );
}
