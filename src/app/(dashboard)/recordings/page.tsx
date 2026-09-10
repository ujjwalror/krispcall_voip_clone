'use client';

import React, { useEffect, useState, useRef } from 'react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Mic, Play, Pause, Download, RefreshCw, Volume2 } from 'lucide-react';
import { formatDuration, formatCallTime } from '@/lib/utils';
import { RecordingRepository, RecordingWithDetails } from '@/lib/repositories/recording.repository';

export default function RecordingsPage() {
  const [recordings, setRecordings] = useState<RecordingWithDetails[]>([]);
  const [activePlayingId, setActivePlayingId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const audioRef = useRef<HTMLAudioElement | null>(null);
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

  const handlePlayToggle = (rec: RecordingWithDetails) => {
    if (activePlayingId === rec.id) {
      if (audioRef.current) {
        audioRef.current.pause();
      }
      setActivePlayingId(null);
    } else {
      if (audioRef.current) {
        audioRef.current.pause();
      }
      const playUrl = `/api/twilio/recording/play/${rec.id}`;
      const audio = new Audio(playUrl);
      audio.onended = () => setActivePlayingId(null);
      audio.play().catch((err) => console.error('Audio playback error:', err));
      audioRef.current = audio;
      setActivePlayingId(rec.id);
    }
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between border-b border-slate-800 pb-4">
        <div>
          <h1 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <span>Call Recordings Vault</span>
            <Badge variant="blue" size="md">
              {recordings.length} RECORDINGS
            </Badge>
          </h1>
          <p className="text-xs text-slate-400">Audio playback and metadata for recorded team calls.</p>
        </div>
        <Button variant="outline" size="sm" onClick={loadRecordings} disabled={isLoading}>
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          <span>Refresh</span>
        </Button>
      </div>

      <div className="space-y-4">
        {isLoading ? (
          <Card className="p-8 text-center text-xs text-slate-500">
            <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2 text-blue-400" />
            <span>Loading recordings vault...</span>
          </Card>
        ) : recordings.length === 0 ? (
          <Card className="p-8 text-center text-xs text-slate-500">
            No call recordings saved yet. Enable call recording in the dialer before making an answered call.
          </Card>
        ) : (
          recordings.map((rec) => {
            const agentName = rec.calls?.profiles?.full_name || 'Agent';
            const targetNumber = rec.calls?.to_number || 'Outbound Call';
            const isPlaying = activePlayingId === rec.id;

            return (
              <Card key={rec.id} hoverable>
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="flex items-center gap-4">
                    <div className="p-3 rounded-2xl bg-blue-600/10 text-blue-400 border border-blue-500/20">
                      <Mic className="w-5 h-5" />
                    </div>
                    <div>
                      <h3 className="text-sm font-bold text-slate-100 font-mono">To: {targetNumber}</h3>
                      <p className="text-xs text-slate-400 font-mono">
                        Handled by {agentName} • {formatDuration(rec.duration_seconds || 0)}
                      </p>
                      <p className="text-[10px] text-slate-500 mt-0.5">
                        {formatCallTime(rec.created_at)}
                      </p>
                    </div>
                  </div>

                  {/* Audio Player Bar Controls */}
                  <div className="flex items-center gap-3 bg-slate-950/80 p-2.5 rounded-xl border border-slate-800">
                    <button
                      onClick={() => handlePlayToggle(rec)}
                      className={`p-2 rounded-lg text-white transition-colors ${
                        isPlaying ? 'bg-rose-600 hover:bg-rose-500' : 'bg-blue-600 hover:bg-blue-500'
                      }`}
                      title={isPlaying ? 'Pause Audio' : 'Play Audio'}
                    >
                      {isPlaying ? (
                        <Pause className="w-4 h-4 fill-current" />
                      ) : (
                        <Play className="w-4 h-4 fill-current" />
                      )}
                    </button>
                    <div className="flex flex-col gap-1 w-32">
                      <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
                        <div
                          className={`h-full bg-blue-500 rounded-full transition-all ${
                            isPlaying ? 'w-3/4 animate-pulse' : 'w-1/4'
                          }`}
                        />
                      </div>
                      <div className="flex justify-between text-[9px] font-mono text-slate-400">
                        <span>{isPlaying ? 'Playing' : 'Audio MP3'}</span>
                        <span>{formatDuration(rec.duration_seconds || 0)}</span>
                      </div>
                    </div>
                    <a
                      href={`/api/twilio/recording/play/${rec.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      download={`recording-${rec.id}.mp3`}
                      className="p-1.5 text-slate-400 hover:text-slate-200"
                      title="Download Audio MP3"
                    >
                      <Download className="w-4 h-4" />
                    </a>
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
