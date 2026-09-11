'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Avatar } from '@/components/ui/Avatar';
import { PhoneMissed, PhoneCall, RefreshCw, AlertCircle } from 'lucide-react';
import { CallRepository, CallWithProfile } from '@/lib/repositories/call.repository';
import { useAuth } from '@/components/providers/AuthProvider';
import { formatCallTime } from '@/lib/utils';
import Link from 'next/link';

export default function MissedCallsPage() {
  const [missedCalls, setMissedCalls] = useState<CallWithProfile[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { profile } = useAuth();
  const callRepo = new CallRepository();

  const loadMissedCalls = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await callRepo.getMissedInboundCalls(profile?.organization_id);
      setMissedCalls(data);
    } catch (err) {
      console.error('Error fetching missed calls:', err);
    } finally {
      setIsLoading(false);
    }
  }, [profile?.organization_id]);

  useEffect(() => {
    if (profile?.organization_id) {
      loadMissedCalls();
    } else {
      setIsLoading(false);
    }
  }, [profile?.organization_id, loadMissedCalls]);

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
          <p className="text-xs text-slate-400">Incoming calls that went unanswered by agents. Instant callback launcher.</p>
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
            return (
              <Card key={item.id} hoverable className="border-rose-900/30">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="flex items-center gap-3.5">
                    <div className="p-2.5 rounded-xl bg-rose-500/10 text-rose-400 shrink-0">
                      <PhoneMissed className="w-5 h-5" />
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-slate-100 font-mono">
                        From: {item.from_number}
                      </h3>
                      <p className="text-xs text-slate-400">
                        {formatCallTime(item.created_at)}
                        {agentName && ` • Ringing target: ${agentName}`}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 self-end sm:self-auto">
                    <Badge variant="rose" size="sm">
                      {item.status === 'no-answer' ? 'NO ANSWER' : (item.status ? item.status.toUpperCase() : 'NO ANSWER')}
                    </Badge>
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
    </div>
  );
}

