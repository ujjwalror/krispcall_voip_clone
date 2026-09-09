import React from 'react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { PhoneMissed, PhoneCall, AlertCircle, CheckCircle2 } from 'lucide-react';

export default function MissedCallsPage() {
  const missedCalls = [
    {
      id: 'm1',
      caller: 'Global Logistics (+1 555-0188)',
      time: '15 minutes ago',
      attempts: 2,
      priority: 'High',
    },
    {
      id: 'm2',
      caller: 'Tech Solutions LLC (+1 555-0129)',
      time: '1 hour ago',
      attempts: 1,
      priority: 'Medium',
    },
    {
      id: 'm3',
      caller: 'Apex Industries (+1 555-0199)',
      time: '3 hours ago',
      attempts: 1,
      priority: 'Low',
    },
  ];

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between border-b border-slate-800 pb-4">
        <div>
          <h1 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <span>Missed Calls Queue</span>
            <Badge variant="rose" size="md" pulse>
              3 UNHANDLED
            </Badge>
          </h1>
          <p className="text-xs text-slate-400">Incoming calls that went unanswered by agents. Instant callback launcher.</p>
        </div>
      </div>

      <div className="space-y-3">
        {missedCalls.map((item) => (
          <Card key={item.id} hoverable className="border-rose-900/30">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3.5">
                <div className="p-2.5 rounded-xl bg-rose-500/10 text-rose-400">
                  <PhoneMissed className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-slate-100">{item.caller}</h3>
                  <p className="text-xs text-slate-400">Missed {item.time} • {item.attempts} ring attempts</p>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <Badge variant={item.priority === 'High' ? 'rose' : 'amber'} size="sm">
                  {item.priority} Priority
                </Badge>
                <Button variant="success" size="sm">
                  <PhoneCall className="w-3.5 h-3.5" />
                  <span>Call Back</span>
                </Button>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
