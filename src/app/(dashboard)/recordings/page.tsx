'use client';

import React, { useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Mic, RefreshCw, Search, ShieldCheck, Clock, Headphones, CheckCircle2 } from 'lucide-react';
import { formatDuration } from '@/lib/utils';
import { RecordingRepository, RecordingWithDetails } from '@/lib/repositories/recording.repository';
import { RecordingCard } from '@/components/recordings/RecordingCard';
import { DeleteRecordingConfirmationModal } from '@/components/recordings/DeleteRecordingConfirmationModal';
import { useAuth } from '@/components/providers/AuthProvider';

export default function RecordingsPage() {
  const { profile } = useAuth();
  const isAdmin = profile?.role === 'admin';

  const [recordings, setRecordings] = useState<RecordingWithDetails[]>([]);
  const [activePlayingId, setActivePlayingId] = useState<string | null>(null);
  const [deletingRecording, setDeletingRecording] = useState<RecordingWithDetails | null>(null);
  const [notificationMessage, setNotificationMessage] = useState<string | null>(null);
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

  const handleRecordingDeletedSuccess = (deletedId: string) => {
    setRecordings((prev) => prev.filter((r) => r.id !== deletedId));
    if (activePlayingId === deletedId) {
      setActivePlayingId(null);
    }
    setNotificationMessage('Recording deleted');
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
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-5">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-blue-50 dark:bg-blue-600/10 border border-blue-200 dark:border-blue-500/20 text-blue-600 dark:text-blue-400">
              <Headphones className="w-5 h-5" />
            </div>
            <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">Call Recordings Vault</h1>
            <Badge variant="blue" size="md">
              {recordings.length} RECORDINGS
            </Badge>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Secure audio vault for compliance, quality monitoring, and team training.
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Total Recorded Time Summary */}
          <div className="hidden sm:flex items-center gap-2 bg-slate-100 dark:bg-slate-900/80 px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-800 text-xs font-mono text-slate-800 dark:text-slate-300">
            <Clock className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
            <span>Total: {formatDuration(totalDurationSeconds)}</span>
          </div>

          <Button variant="outline" size="sm" onClick={loadRecordings} disabled={isLoading}>
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            <span>Refresh Vault</span>
          </Button>
        </div>
      </div>

      {/* Notification Banner */}
      {notificationMessage && (
        <div className="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/80 border border-emerald-200 dark:border-emerald-700 text-emerald-800 dark:text-emerald-200 text-xs flex items-center justify-between animate-in fade-in">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <span>{notificationMessage}</span>
          </div>
          <button
            onClick={() => setNotificationMessage(null)}
            className="text-emerald-600 dark:text-emerald-400 hover:text-emerald-900 dark:hover:text-emerald-200"
          >
            ✕
          </button>
        </div>
      )}

      {/* Filter / Search Control Bar */}
      <div className="flex items-center justify-between gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-slate-400 dark:text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Search by agent name or phone number..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 rounded-xl pl-9 pr-4 py-2 text-xs text-slate-900 dark:text-slate-200 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:border-blue-600 dark:focus:border-blue-500/60 transition-colors"
          />
        </div>

        <div className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400 font-mono">
          <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
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
              isAdmin={isAdmin}
              onPlayToggle={() => handlePlayToggle(rec.id)}
              onRequestDelete={(targetRec) => setDeletingRecording(targetRec)}
            />
          ))
        )}
      </div>

      {/* Admin Delete Confirmation Modal */}
      <DeleteRecordingConfirmationModal
        recording={deletingRecording}
        isOpen={Boolean(deletingRecording)}
        onClose={() => setDeletingRecording(null)}
        onSuccess={handleRecordingDeletedSuccess}
      />
    </div>
  );
}
