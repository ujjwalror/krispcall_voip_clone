'use client';

import React, { useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Mic, Download, ArrowUpRight, ArrowDownLeft, Clock, User, Phone, CheckCircle2, Loader2, Trash2 } from 'lucide-react';
import { formatDuration, formatCallTime } from '@/lib/utils';
import { RecordingWithDetails } from '@/lib/repositories/recording.repository';
import { RecordingAudioPlayer } from './RecordingAudioPlayer';

interface RecordingCardProps {
  recording: RecordingWithDetails;
  isPlaying: boolean;
  isAdmin?: boolean;
  onPlayToggle: () => void;
  onRequestDelete?: (recording: RecordingWithDetails) => void;
}

export function RecordingCard({ recording, isPlaying, isAdmin = false, onPlayToggle, onRequestDelete }: RecordingCardProps) {
  const [isDownloading, setIsDownloading] = useState(false);

  const agentName = recording.calls?.profiles?.full_name || 'VoIP Agent';
  const direction = recording.calls?.direction || 'outbound';
  const targetNumber =
    direction === 'outbound'
      ? recording.calls?.to_number || 'Unknown Destination'
      : recording.calls?.from_number || 'Unknown Caller';

  const downloadUrl = `/api/twilio/recording/play/${recording.id}`;

  const handleDownload = async (e: React.MouseEvent) => {
    e.preventDefault();
    if (isDownloading) return;

    try {
      setIsDownloading(true);
      const res = await fetch(downloadUrl);
      if (!res.ok) throw new Error('Download request failed');

      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);

      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = `call-recording-${recording.id.slice(0, 8)}.mp3`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(blobUrl);
    } catch (err) {
      console.error('[RecordingCard] Download failed:', err);
    } finally {
      setIsDownloading(false);
    }
  };

  // Generate agent initials avatar
  const initials = agentName
    .split(' ')
    .map((n) => n[0])
    .join('')
    .substring(0, 2)
    .toUpperCase();

  return (
    <Card className="p-5 bg-slate-900/60 border border-slate-800 hover:border-slate-700/80 transition-all rounded-2xl shadow-lg backdrop-blur-sm group">
      <div className="flex flex-col gap-4">
        {/* Top Header Row */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/60 pb-3">
          <div className="flex items-center gap-3">
            {/* Call Direction Indicator Badge */}
            <div
              className={`p-2.5 rounded-xl border flex items-center justify-center ${
                direction === 'inbound'
                  ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                  : 'bg-blue-500/10 text-blue-400 border-blue-500/20'
              }`}
            >
              {direction === 'inbound' ? (
                <ArrowDownLeft className="w-4 h-4" />
              ) : (
                <ArrowUpRight className="w-4 h-4" />
              )}
            </div>

            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-slate-100 font-mono tracking-tight">{targetNumber}</h3>
                <Badge
                  variant={direction === 'inbound' ? 'emerald' : 'blue'}
                  size="sm"
                  className="uppercase text-[9px]"
                >
                  {direction}
                </Badge>
              </div>
              <p className="text-[11px] text-slate-400 flex items-center gap-1.5 mt-0.5">
                <Clock className="w-3 h-3 text-slate-500" />
                <span>{formatCallTime(recording.created_at)}</span>
              </p>
            </div>
          </div>

          {/* Right Meta Info & Download */}
          <div className="flex items-center gap-3">
            {/* Agent Info */}
            <div className="flex items-center gap-2 bg-slate-950/60 px-3 py-1.5 rounded-xl border border-slate-800/60">
              <div className="w-5 h-5 rounded-full bg-blue-600/30 border border-blue-500/40 text-blue-300 text-[10px] font-bold flex items-center justify-center">
                {initials}
              </div>
              <span className="text-xs text-slate-300 font-medium">{agentName}</span>
            </div>

            {/* Duration Badge */}
            <div className="flex items-center gap-1 bg-slate-950/60 px-2.5 py-1.5 rounded-xl border border-slate-800/60 text-slate-400 text-xs font-mono">
              <Mic className="w-3.5 h-3.5 text-blue-400" />
              <span>{formatDuration(recording.duration_seconds || 0)}</span>
            </div>

            {/* Secure Download Button */}
            <button
              onClick={handleDownload}
              disabled={isDownloading}
              className="p-2 rounded-xl bg-slate-950/80 border border-slate-800 text-slate-400 hover:text-white hover:border-slate-700 transition-all flex items-center justify-center"
              title="Download MP3 Audio"
            >
              {isDownloading ? (
                <Loader2 className="w-4 h-4 animate-spin text-blue-400" />
              ) : (
                <Download className="w-4 h-4" />
              )}
            </button>

            {/* Admin-Only Delete Recording Action */}
            {isAdmin && onRequestDelete && (
              <button
                onClick={() => onRequestDelete(recording)}
                className="p-2 rounded-xl bg-slate-950/80 border border-slate-800 text-slate-400 hover:text-rose-400 hover:border-rose-900/80 hover:bg-rose-950/40 transition-all flex items-center justify-center"
                title="Delete Recording (Admin Only)"
              >
                <Trash2 className="w-4 h-4 text-rose-400" />
              </button>
            )}
          </div>
        </div>

        {/* Audio Waveform Player */}
        <RecordingAudioPlayer
          recordingId={recording.id}
          durationSeconds={recording.duration_seconds || 0}
          isPlaying={isPlaying}
          onPlayToggle={onPlayToggle}
        />
      </div>
    </Card>
  );
}
