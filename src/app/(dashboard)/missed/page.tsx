'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { PhoneMissed, PhoneCall, RefreshCw, Ban } from 'lucide-react';
import { CallRepository, CallWithProfile } from '@/lib/repositories/call.repository';
import { useAuth } from '@/components/providers/AuthProvider';
import { formatCallTime, normalizeE164PhoneNumber } from '@/lib/utils';
import { BlockNumberConfirmationModal } from '@/components/call/BlockNumberConfirmationModal';
import Link from 'next/link';

export default function MissedCallsPage() {
  const [missedCalls, setMissedCalls] = useState<CallWithProfile[]>([]);
  const [blockedNumbersMap, setBlockedNumbersMap] = useState<Record<string, boolean>>({});
  const [isLoading, setIsLoading] = useState(true);

  // Modal state for direct block action
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

  const loadMissedCalls = useCallback(async () => {
    setIsLoading(true);
    try {
      const [data] = await Promise.all([
        callRepo.getMissedInboundCalls(profile?.organization_id),
        loadBlockedNumbers(),
      ]);
      // Filter out status = 'blocked' so blocked calls do not appear as actionable missed calls
      const activeMissed = data.filter((item) => item.status !== 'blocked');
      setMissedCalls(activeMissed);
    } catch (err) {
      console.error('Error fetching missed calls:', err);
    } finally {
      setIsLoading(false);
    }
  }, [profile?.organization_id, loadBlockedNumbers]);

  useEffect(() => {
    if (profile?.organization_id) {
      loadMissedCalls();
    } else {
      setIsLoading(false);
    }
  }, [profile?.organization_id, loadMissedCalls]);

  const handleUnblockPhone = async (phone: string) => {
    try {
      const res = await fetch(`/api/blocked-numbers`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      });
      if (res.ok) {
        loadMissedCalls();
      }
    } catch (err) {
      console.error('Error unblocking phone:', err);
    }
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between border-b border-slate-800 pb-4">
        <div>
          <h1 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <span>Missed Calls Queue</span>
            <Badge variant={missedCalls.length > 0 ? 'rose' : 'emerald'} size="md" pulse={missedCalls.length > 0}>
              {missedCalls.length} UNHANDLED
            </Badge>
          </h1>
          <p className="text-xs text-slate-400">Incoming calls that went unanswered by agents. Instant callback & block control launcher.</p>
        </div>
        <Button variant="outline" size="sm" onClick={loadMissedCalls} disabled={isLoading}>
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          <span>Refresh</span>
        </Button>
      </div>

      <div className="space-y-3">
        {isLoading ? (
          <Card className="p-8 text-center text-xs text-slate-400">
            <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2 text-rose-400" />
            Loading missed call logs...
          </Card>
        ) : missedCalls.length === 0 ? (
          <Card className="p-8 text-center text-slate-400 space-y-2">
            <PhoneMissed className="w-8 h-8 text-slate-600 mx-auto" />
            <p className="text-sm font-semibold text-slate-300">No Missed Calls</p>
            <p className="text-xs text-slate-500">Great job! All incoming business calls have been handled by agents.</p>
          </Card>
        ) : (
          missedCalls.map((item) => {
            const agentName = item.profiles?.full_name || null;
            const normalizedFrom = normalizeE164PhoneNumber(item.from_number).normalized || item.from_number;
            const isBlocked = Boolean(blockedNumbersMap[normalizedFrom]);

            return (
              <Card key={item.id} hoverable className="border-rose-900/30">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="flex items-center gap-3.5">
                    <div className="p-2.5 rounded-xl bg-rose-500/10 text-rose-400 shrink-0">
                      <PhoneMissed className="w-5 h-5" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-semibold text-slate-100 font-mono">
                          From: {item.from_number}
                        </h3>
                        {isBlocked && (
                          <Badge variant="rose" size="sm">
                            <Ban className="w-2.5 h-2.5" />
                            BLOCKED
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-slate-400 mt-0.5">
                        {formatCallTime(item.created_at)}
                        {agentName && ` • Ringing target: ${agentName}`}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2.5 self-end sm:self-auto">
                    {isBlocked ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="border-emerald-700/60 text-emerald-300 hover:bg-emerald-950/60"
                        onClick={() => handleUnblockPhone(item.from_number)}
                      >
                        <Ban className="w-3.5 h-3.5 text-emerald-400" />
                        <span>Unblock</span>
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="border-amber-900/60 text-amber-300 hover:bg-amber-950/60"
                        onClick={() => setBlockingPhone(item.from_number)}
                      >
                        <Ban className="w-3.5 h-3.5 text-amber-400" />
                        <span>Block Number</span>
                      </Button>
                    )}

                    <Link href={`/phone?number=${encodeURIComponent(item.from_number)}`}>
                      <Button variant="success" size="sm">
                        <PhoneCall className="w-3.5 h-3.5" />
                        <span>Call Back</span>
                      </Button>
                    </Link>
                  </div>
                </div>
              </Card>
            );
          })
        )}
      </div>

      <BlockNumberConfirmationModal
        phoneNumber={blockingPhone}
        isOpen={Boolean(blockingPhone)}
        onClose={() => setBlockingPhone(null)}
        onSuccess={loadMissedCalls}
      />
    </div>
  );
}
