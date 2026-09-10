'use client';

import React, { useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Mic, RefreshCw, Search, ShieldCheck, Clock, Headphones } from 'lucide-react';
import { formatDuration } from '@/lib/utils';
import { RecordingRepository, RecordingWithDetails } from '@/lib/repositories/recording.repository';
import { RecordingCard } from '@/components/recordings/RecordingCard';

export default function RecordingsPage() {
  const [recordings, setRecordings] = useState<RecordingWithDetails[]>([]);
  const [activePlayingId, setActivePlayingId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  const recordingRepo = new RecordingRepository();

  const loadRecordings = async () => {
    setIsLoading(true);
    try {
      const data = await recordingRepo.getRecordings();
      setRecordings(data);
    } catch (err) {
      console.error('Error loading recordings:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadRecordings();
  }, []);

  const handlePlayToggle = (recordingId: string) => {
    if (activePlayingId === recordingId) {
      setActivePlayingId(null);
    } else {
      setActivePlayingId(recordingId);
    }
  };

  // Filter recordings by phone number or agent name
  const filteredRecordings = recordings.filter((rec) => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return true;

    const agentName = (rec.calls?.profiles?.full_name || '').toLowerCase();
    const toNumber = (rec.calls?.to_number || '').toLowerCase();
    const fromNumber = (rec.calls?.from_number || '').toLowerCase();

    return agentName.includes(q) || toNumber.includes(q) || fromNumber.includes(q);
  });

  const totalDurationSeconds = recordings.reduce(
    (acc, rec) => acc + (rec.duration_seconds || 0),
    0
  );

  return (
    <div className="space-y-6 max-w-5xl mx-auto pb-12">
      {/* Header Banner */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-5">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-blue-600/10 border border-blue-500/20 text-blue-400">
              <Headphones className="w-5 h-5" />
            </div>
            <h1 className="text-xl font-bold text-slate-100">Call Recordings Vault</h1>
            <Badge variant="blue" size="md">
              {recordings.length} RECORDINGS
            </Badge>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Secure audio vault for compliance, quality monitoring, and team training.
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Total Recorded Time Summary */}
          <div className="hidden sm:flex items-center gap-2 bg-slate-900/80 px-3 py-1.5 rounded-xl border border-slate-800 text-xs font-mono text-slate-300">
            <Clock className="w-3.5 h-3.5 text-blue-400" />
            <span>Total: {formatDuration(totalDurationSeconds)}</span>
          </div>

          <Button variant="outline" size="sm" onClick={loadRecordings} disabled={isLoading}>
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            <span>Refresh Vault</span>
          </Button>
        </div>
      </div>

      {/* Filter / Search Control Bar */}
      <div className="flex items-center justify-between gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Search by agent name or phone number..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-slate-900/80 border border-slate-800 rounded-xl pl-9 pr-4 py-2 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-blue-500/60 transition-colors"
          />
        </div>

        <div className="flex items-center gap-1.5 text-[11px] text-slate-400 font-mono">
          <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
          <span className="hidden sm:inline">Protected proxy audio streaming active</span>
        </div>
      </div>

      {/* Recordings List */}
      <div className="space-y-4">
        {isLoading ? (
          <Card className="p-12 text-center text-xs text-slate-500">
            <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-3 text-blue-400" />
            <span>Loading recordings vault...</span>
          </Card>
        ) : filteredRecordings.length === 0 ? (
          <Card className="p-12 text-center text-xs text-slate-500">
            <Mic className="w-8 h-8 text-slate-600 mx-auto mb-3 opacity-60" />
            {searchQuery ? (
              <p>No call recordings match your search query "{searchQuery}".</p>
            ) : (
              <p>
                No call recordings saved yet. Enable call recording in the dialer before making an answered call.
              </p>
            )}
          </Card>
        ) : (
          filteredRecordings.map((rec) => (
            <RecordingCard
              key={rec.id}
              recording={rec}
              isPlaying={activePlayingId === rec.id}
              onPlayToggle={() => handlePlayToggle(rec.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}
