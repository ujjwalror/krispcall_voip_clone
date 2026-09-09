import React from 'react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Avatar } from '@/components/ui/Avatar';
import { Mic, Play, Pause, Download, Volume2, Clock, Calendar } from 'lucide-react';
import { formatDuration } from '@/lib/utils';

export default function RecordingsPage() {
  const recordings = [
    {
      id: 'rec_1',
      contact: 'Acme Corp (John Doe)',
      number: '+1 (555) 014-4321',
      duration: 252,
      date: 'Sep 9, 2026 • 10:15 AM',
      agent: 'Sarah Jenkins',
    },
    {
      id: 'rec_2',
      contact: 'Cyberdyne Systems',
      number: '+1 (555) 019-8821',
      duration: 525,
      date: 'Sep 9, 2026 • 09:40 AM',
      agent: 'Alex Smith',
    },
  ];

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between border-b border-slate-800 pb-4">
        <div>
          <h1 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <span>Call Recordings Vault</span>
            <Badge variant="blue" size="md">
              2 RECORDINGS
            </Badge>
          </h1>
          <p className="text-xs text-slate-400">Audio playback and metadata for recorded team calls.</p>
        </div>
      </div>

      <div className="space-y-4">
        {recordings.map((rec) => (
          <Card key={rec.id} hoverable>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-2xl bg-blue-600/10 text-blue-400 border border-blue-500/20">
                  <Mic className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-100">{rec.contact}</h3>
                  <p className="text-xs text-slate-400 font-mono">{rec.number} • Handled by {rec.agent}</p>
                  <p className="text-[10px] text-slate-500 mt-0.5">{rec.date}</p>
                </div>
              </div>

              {/* Audio Player Bar Presentation */}
              <div className="flex items-center gap-3 bg-slate-950/80 p-2.5 rounded-xl border border-slate-800">
                <button className="p-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors">
                  <Play className="w-4 h-4 fill-current" />
                </button>
                <div className="flex flex-col gap-1 w-32">
                  <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
                    <div className="h-full w-1/3 bg-blue-500 rounded-full" />
                  </div>
                  <div className="flex justify-between text-[9px] font-mono text-slate-400">
                    <span>01:24</span>
                    <span>{formatDuration(rec.duration)}</span>
                  </div>
                </div>
                <button className="p-1.5 text-slate-400 hover:text-slate-200" title="Download Audio">
                  <Download className="w-4 h-4" />
                </button>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
