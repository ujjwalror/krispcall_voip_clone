'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import {
  Voicemail as VoicemailIcon,
  Play,
  Pause,
  Trash2,
  CheckCircle2,
  Circle,
  Loader2,
  Volume2,
  Clock,
  Phone,
  PhoneIncoming,
  AlertCircle,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { formatCallTime } from '@/lib/utils';

interface VoicemailItem {
  id: string;
  organizationId: string;
  phoneNumberId: string | null;
  callId: string | null;
  providerCallSid: string;
  providerRecordingSid: string;
  callerNumber: string;
  calledNumber: string;
  recordingUrl: string;
  durationSeconds: number;
  status: string;
  isRead: boolean;
  createdAt: string;
  updatedAt: string;
  calledPhoneFriendlyName?: string | null;
}

export default function VoicemailInboxPage() {
  const [voicemails, setVoicemails] = useState<VoicemailItem[]>([]);
  const [unreadCount, setUnreadCount] = useState<number>(0);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isEntitled, setIsEntitled] = useState<boolean>(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Audio Playback State
  const [activePlayingId, setActivePlayingId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [isMutating, setIsMutating] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);

  const fetchVoicemails = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const res = await fetch('/api/voicemails');
      if (res.status === 403) {
        const json = await res.json().catch(() => ({}));
        if (json.error === 'entitlement_denied') {
          setIsEntitled(false);
          setIsLoading(false);
          return;
        }
      }

      if (res.ok) {
        const json = await res.json();
        setVoicemails(json.voicemails || []);
        setUnreadCount(json.unreadCount || 0);
        setTotalCount(json.totalCount || 0);
        setIsEntitled(true);
      } else {
        const json = await res.json().catch(() => ({}));
        setErrorMessage(json.message || 'Failed to load voicemails.');
      }
    } catch (err) {
      console.error('[VoicemailInboxPage] Error fetching voicemails:', err);
      setErrorMessage('Network error fetching voicemails.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchVoicemails();
  }, [fetchVoicemails]);

  // Handle Play/Pause
  const handleTogglePlay = (vm: VoicemailItem) => {
    if (activePlayingId === vm.id) {
      if (isPlaying && audioRef.current) {
        audioRef.current.pause();
        setIsPlaying(false);
      } else if (audioRef.current) {
        audioRef.current.play().catch(console.error);
        setIsPlaying(true);
      }
    } else {
      if (audioRef.current) {
        audioRef.current.pause();
      }
      setActivePlayingId(vm.id);
      setIsPlaying(true);
      setCurrentTime(0);
      setDuration(vm.durationSeconds || 0);

      // Auto-mark as read when played
      if (!vm.isRead) {
        handleMarkRead(vm.id, true);
      }
    }
  };

  const handleMarkRead = async (id: string, isRead: boolean) => {
    setIsMutating(id);
    try {
      const res = await fetch(`/api/voicemails/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isRead }),
      });
      if (res.ok) {
        setVoicemails((prev) =>
          prev.map((v) => (v.id === id ? { ...v, isRead } : v))
        );
        setUnreadCount((prev) => (isRead ? Math.max(0, prev - 1) : prev + 1));
      }
    } catch (err) {
      console.error('[VoicemailInboxPage] Mark read error:', err);
    } finally {
      setIsMutating(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (activePlayingId === id && audioRef.current) {
      audioRef.current.pause();
      setActivePlayingId(null);
      setIsPlaying(false);
    }

    setIsMutating(id);
    try {
      const res = await fetch(`/api/voicemails/${id}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        const deletedVm = voicemails.find((v) => v.id === id);
        if (deletedVm && !deletedVm.isRead) {
          setUnreadCount((prev) => Math.max(0, prev - 1));
        }
        setVoicemails((prev) => prev.filter((v) => v.id !== id));
        setTotalCount((prev) => Math.max(0, prev - 1));
      }
    } catch (err) {
      console.error('[VoicemailInboxPage] Delete error:', err);
    } finally {
      setIsMutating(null);
    }
  };

  const formatDuration = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  if (!isEntitled) {
    return (
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
              <VoicemailIcon className="w-6 h-6 text-blue-600 dark:text-blue-400" />
              <span>Voicemail Inbox</span>
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              Listen to and manage incoming customer voicemail recordings
            </p>
          </div>
        </div>

        <Card className="border-amber-200 dark:border-amber-900/60 bg-amber-50/50 dark:bg-amber-950/20">
          <div className="p-8 text-center space-y-4">
            <div className="w-12 h-12 rounded-2xl bg-amber-100 dark:bg-amber-900/40 text-amber-600 dark:text-amber-400 flex items-center justify-center mx-auto">
              <Sparkles className="w-6 h-6" />
            </div>
            <div className="space-y-1 max-w-md mx-auto">
              <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">
                Voicemail Upgrade Required
              </h3>
              <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                Voicemail foundation and inbox capabilities are included in the <strong>Pro</strong> and <strong>Business</strong> subscription plans. Your current <strong>Starter</strong> plan does not include voicemail entitlement.
              </p>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6 pb-12">
      {/* Hidden Audio Element for Secure Audio Stream */}
      {activePlayingId && (
        <audio
          ref={audioRef}
          src={`/api/voicemails/${activePlayingId}/play`}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={() => {
            setIsPlaying(false);
            setCurrentTime(0);
          }}
          onTimeUpdate={(e) => {
            const el = e.currentTarget;
            setCurrentTime(Math.floor(el.currentTime));
            if (el.duration && !isNaN(el.duration)) {
              setDuration(Math.floor(el.duration));
            }
          }}
          autoPlay
        />
      )}

      {/* HEADER SECTION */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <VoicemailIcon className="w-6 h-6 text-blue-600 dark:text-blue-400" />
            <span>Voicemail Inbox</span>
            {unreadCount > 0 && (
              <span className="px-2.5 py-0.5 rounded-full text-xs font-extrabold bg-blue-600 text-white shadow-sm">
                {unreadCount} New
              </span>
            )}
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Listen to, mark as read, and manage your workspace voicemail messages
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Button
            size="sm"
            variant="outline"
            onClick={fetchVoicemails}
            disabled={isLoading}
            className="text-xs font-semibold"
          >
            <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${isLoading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </Button>
        </div>
      </div>

      {/* ERROR DISPLAY */}
      {errorMessage && (
        <div className="p-3.5 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/60 text-red-700 dark:text-red-300 text-xs flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* INBOX MAIN CARD */}
      <Card>
        <CardHeader className="border-b border-slate-200/60 dark:border-slate-800/60 py-3.5 px-4 flex flex-row items-center justify-between">
          <CardTitle className="text-xs font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <span>All Messages ({totalCount})</span>
          </CardTitle>
          <span className="text-[11px] text-slate-400 font-medium">
            Tenant Isolated • Secure Audio Playback
          </span>
        </CardHeader>

        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-16 space-y-3">
            <Loader2 className="w-6 h-6 text-blue-500 animate-spin" />
            <p className="text-xs text-slate-400 font-medium">Loading voicemail messages...</p>
          </div>
        ) : voicemails.length === 0 ? (
          <div className="py-16 text-center space-y-3">
            <div className="w-12 h-12 rounded-2xl bg-slate-100 dark:bg-slate-900 text-slate-400 flex items-center justify-center mx-auto">
              <VoicemailIcon className="w-6 h-6" />
            </div>
            <div className="space-y-1">
              <h4 className="text-sm font-bold text-slate-900 dark:text-slate-100">No voicemails yet</h4>
              <p className="text-xs text-slate-500 dark:text-slate-400 max-w-sm mx-auto">
                Incoming calls routed to voicemail will be recorded and displayed here automatically.
              </p>
            </div>
          </div>
        ) : (
          <div className="divide-y divide-slate-200/60 dark:divide-slate-800/60">
            {voicemails.map((vm) => {
              const isSelectedPlaying = activePlayingId === vm.id;
              const isCurrentlyPlaying = isSelectedPlaying && isPlaying;

              return (
                <div
                  key={vm.id}
                  className={`p-4 transition-all duration-150 flex flex-col sm:flex-row sm:items-center justify-between gap-4 ${
                    !vm.isRead
                      ? 'bg-blue-50/40 dark:bg-blue-950/20'
                      : 'hover:bg-slate-50/60 dark:hover:bg-slate-900/40'
                  }`}
                >
                  {/* Left Column: Caller & Metadata */}
                  <div className="flex items-start gap-3 flex-1 min-w-0">
                    <button
                      type="button"
                      onClick={() => handleTogglePlay(vm)}
                      className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 transition-all ${
                        isCurrentlyPlaying
                          ? 'bg-blue-600 text-white shadow-md shadow-blue-600/30'
                          : 'bg-blue-100 dark:bg-blue-950/80 text-blue-600 dark:text-blue-400 hover:bg-blue-600 hover:text-white'
                      }`}
                    >
                      {isCurrentlyPlaying ? (
                        <Pause className="w-4 h-4" />
                      ) : (
                        <Play className="w-4 h-4 ml-0.5" />
                      )}
                    </button>

                    <div className="space-y-1 min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-bold text-slate-900 dark:text-slate-100 font-mono">
                          {vm.callerNumber}
                        </span>
                        {!vm.isRead && (
                          <span className="px-1.5 py-0.5 text-[10px] font-bold rounded bg-blue-600 text-white">
                            NEW
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-3 text-[11px] text-slate-500 dark:text-slate-400 flex-wrap">
                        <span className="flex items-center gap-1">
                          <Phone className="w-3 h-3 text-slate-400" />
                          <span>To: {vm.calledPhoneFriendlyName || vm.calledNumber}</span>
                        </span>
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3 text-slate-400" />
                          <span>{formatCallTime(vm.createdAt)}</span>
                        </span>
                      </div>

                      {/* Seek / Audio Player Progress Bar when active */}
                      {isSelectedPlaying && (
                        <div className="pt-2 max-w-md space-y-1">
                          <div className="flex items-center justify-between text-[10px] text-slate-500 font-mono">
                            <span>{formatDuration(currentTime)}</span>
                            <span>{formatDuration(duration || vm.durationSeconds)}</span>
                          </div>
                          <div className="w-full bg-slate-200 dark:bg-slate-800 rounded-full h-1.5 overflow-hidden">
                            <div
                              className="bg-blue-600 h-1.5 transition-all duration-200"
                              style={{
                                width: `${
                                  (duration || vm.durationSeconds) > 0
                                    ? Math.min(
                                        100,
                                        (currentTime / (duration || vm.durationSeconds)) * 100
                                      )
                                    : 0
                                }%`,
                              }}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Right Column: Duration & Actions */}
                  <div className="flex items-center justify-between sm:justify-end gap-3 border-t sm:border-t-0 pt-2 sm:pt-0 border-slate-200/50 dark:border-slate-800/50">
                    <span className="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-900 font-mono text-[11px] font-semibold text-slate-700 dark:text-slate-300">
                      {formatDuration(vm.durationSeconds)}
                    </span>

                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleMarkRead(vm.id, !vm.isRead)}
                        disabled={isMutating === vm.id}
                        title={vm.isRead ? 'Mark as unread' : 'Mark as read'}
                        className="h-8 w-8 p-0 text-slate-500 hover:text-blue-600 dark:hover:text-blue-400"
                      >
                        {vm.isRead ? (
                          <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                        ) : (
                          <Circle className="w-4 h-4 text-blue-500" />
                        )}
                      </Button>

                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleDelete(vm.id)}
                        disabled={isMutating === vm.id}
                        title="Delete voicemail"
                        className="h-8 w-8 p-0 text-slate-400 hover:text-red-600 dark:hover:text-red-400"
                      >
                        {isMutating === vm.id ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Trash2 className="w-4 h-4" />
                        )}
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
