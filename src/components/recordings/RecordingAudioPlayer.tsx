'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Play, Pause, RotateCcw, Volume2, VolumeX, Loader2, Gauge } from 'lucide-react';
import { formatDuration } from '@/lib/utils';

interface RecordingAudioPlayerProps {
  recordingId: string;
  durationSeconds: number;
  isPlaying: boolean;
  onPlayToggle: () => void;
}

const SPEED_OPTIONS = [1, 1.25, 1.5, 2];

export function RecordingAudioPlayer({
  recordingId,
  durationSeconds,
  isPlaying,
  onPlayToggle,
}: RecordingAudioPlayerProps) {
  const [audioState, setAudioState] = useState<'idle' | 'loading' | 'playing' | 'paused' | 'ended'>('idle');
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [totalDuration, setTotalDuration] = useState<number>(durationSeconds || 0);
  const [playbackRate, setPlaybackRate] = useState<number>(1);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [waveformBars, setWaveformBars] = useState<number[]>([]);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const waveformRef = useRef<HTMLDivElement | null>(null);

  const streamUrl = `/api/twilio/recording/play/${recordingId}`;

  // Generate a realistic waveform bar representation deterministically using recordingId hash
  useEffect(() => {
    const bars: number[] = [];
    const barCount = 42;
    let seed = 0;
    for (let i = 0; i < recordingId.length; i++) {
      seed += recordingId.charCodeAt(i);
    }

    for (let i = 0; i < barCount; i++) {
      // Create pseudo-random heights between 20% and 100%
      const val = Math.abs(Math.sin((seed + i * 7) * 0.4) * 0.75 + Math.cos((seed + i * 3) * 0.25) * 0.25);
      const heightPercent = Math.max(20, Math.min(100, Math.round(val * 100)));
      bars.push(heightPercent);
    }
    setWaveformBars(bars);
  }, [recordingId]);

  // Clean up audio on unmount or when stopped from outside
  useEffect(() => {
    if (!isPlaying && audioRef.current && !audioRef.current.paused) {
      audioRef.current.pause();
      setAudioState('paused');
    }
  }, [isPlaying]);

  const initAudioIfNeeded = () => {
    if (!audioRef.current) {
      const audio = new Audio(streamUrl);
      audio.playbackRate = playbackRate;
      audio.muted = isMuted;

      audio.onwaiting = () => setAudioState('loading');
      audio.oncanplay = () => {
        if (audioState === 'loading') setAudioState(isPlaying ? 'playing' : 'paused');
      };

      audio.onloadedmetadata = () => {
        if (audio.duration && !isNaN(audio.duration) && isFinite(audio.duration)) {
          setTotalDuration(Math.round(audio.duration));
        }
      };

      audio.ontimeupdate = () => {
        setCurrentTime(audio.currentTime);
      };

      audio.onended = () => {
        setAudioState('ended');
        setCurrentTime(0);
        if (isPlaying) onPlayToggle();
      };

      audio.onerror = (e) => {
        console.error('[RecordingAudioPlayer] Audio loading error:', e);
        setAudioState('idle');
      };

      audioRef.current = audio;
    }
  };

  const handleTogglePlay = () => {
    initAudioIfNeeded();
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying) {
      audio.pause();
      setAudioState('paused');
      onPlayToggle();
    } else {
      setAudioState('loading');
      onPlayToggle();
      audio
        .play()
        .then(() => {
          setAudioState('playing');
        })
        .catch((err) => {
          console.error('[RecordingAudioPlayer] Play failure:', err);
          setAudioState('idle');
        });
    }
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!waveformRef.current) return;
    const rect = waveformRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const percentage = Math.max(0, Math.min(1, clickX / rect.width));

    const targetDuration = totalDuration || durationSeconds || 1;
    const newTime = percentage * targetDuration;

    setCurrentTime(newTime);
    if (audioRef.current) {
      audioRef.current.currentTime = newTime;
    }
  };

  const handleSpeedChange = (speed: number) => {
    setPlaybackRate(speed);
    if (audioRef.current) {
      audioRef.current.playbackRate = speed;
    }
  };

  const handleMuteToggle = () => {
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    if (audioRef.current) {
      audioRef.current.muted = nextMuted;
    }
  };

  const progressPercent = totalDuration > 0 ? (currentTime / totalDuration) * 100 : 0;

  return (
    <div className="flex flex-col gap-2 bg-slate-950/80 p-3 rounded-xl border border-slate-800/80 backdrop-blur-md w-full">
      <div className="flex items-center gap-3">
        {/* Play / Pause / Replay Button */}
        <button
          onClick={handleTogglePlay}
          className={`p-2.5 rounded-xl text-white transition-all transform active:scale-95 shadow-md flex items-center justify-center ${
            audioState === 'loading'
              ? 'bg-blue-600/70 cursor-wait'
              : isPlaying
              ? 'bg-rose-600 hover:bg-rose-500 shadow-rose-600/20'
              : audioState === 'ended'
              ? 'bg-amber-600 hover:bg-amber-500 shadow-amber-600/20'
              : 'bg-blue-600 hover:bg-blue-500 shadow-blue-600/20'
          }`}
          title={
            audioState === 'loading'
              ? 'Buffering Audio...'
              : isPlaying
              ? 'Pause Playback'
              : audioState === 'ended'
              ? 'Replay Recording'
              : 'Play Recording'
          }
        >
          {audioState === 'loading' ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : isPlaying ? (
            <Pause className="w-4 h-4 fill-current" />
          ) : audioState === 'ended' ? (
            <RotateCcw className="w-4 h-4" />
          ) : (
            <Play className="w-4 h-4 fill-current ml-0.5" />
          )}
        </button>

        {/* Audio Waveform Interactive Bar */}
        <div
          ref={waveformRef}
          onClick={handleSeek}
          className="flex-1 flex items-center gap-0.5 h-10 px-2 cursor-pointer group rounded-lg hover:bg-slate-900/50 transition-colors relative"
          title="Click to seek"
        >
          {waveformBars.map((height, idx) => {
            const barProgress = (idx / waveformBars.length) * 100;
            const isPlayed = barProgress <= progressPercent;

            return (
              <div
                key={idx}
                className="flex-1 flex items-center justify-center h-full"
              >
                <div
                  style={{ height: `${height}%` }}
                  className={`w-full max-w-[4px] rounded-full transition-all duration-150 ${
                    isPlayed
                      ? 'bg-gradient-to-t from-blue-600 to-cyan-400 opacity-100 shadow-[0_0_8px_rgba(59,130,246,0.5)]'
                      : 'bg-slate-700/60 opacity-60 group-hover:bg-slate-600'
                  } ${isPlaying && isPlayed ? 'animate-pulse' : ''}`}
                />
              </div>
            );
          })}
        </div>

        {/* Speed Controls */}
        <div className="flex items-center gap-1 bg-slate-900/90 p-1 rounded-lg border border-slate-800">
          <Gauge className="w-3 h-3 text-slate-400 ml-1 hidden sm:block" />
          {SPEED_OPTIONS.map((speed) => (
            <button
              key={speed}
              onClick={() => handleSpeedChange(speed)}
              className={`px-1.5 py-0.5 text-[10px] font-mono rounded transition-colors ${
                playbackRate === speed
                  ? 'bg-blue-600 text-white font-bold'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
              }`}
              title={`Playback Speed ${speed}x`}
            >
              {speed}x
            </button>
          ))}
        </div>

        {/* Volume / Mute Toggle */}
        <button
          onClick={handleMuteToggle}
          className="p-1.5 text-slate-400 hover:text-slate-200 transition-colors"
          title={isMuted ? 'Unmute Audio' : 'Mute Audio'}
        >
          {isMuted ? <VolumeX className="w-4 h-4 text-rose-400" /> : <Volume2 className="w-4 h-4" />}
        </button>
      </div>

      {/* Time Indicator Bar */}
      <div className="flex items-center justify-between px-1 text-[10px] font-mono text-slate-400">
        <span className="flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full ${isPlaying ? 'bg-emerald-400 animate-ping' : 'bg-slate-600'}`} />
          <span>{formatDuration(Math.round(currentTime))}</span>
        </span>
        <span className="text-slate-500">/</span>
        <span>{formatDuration(totalDuration)}</span>
      </div>
    </div>
  );
}
