'use client';

import React from 'react';
import { Button } from '@/components/ui/Button';
import { Phone, PhoneOff, Mic, MicOff, Loader2, CheckCircle2, User } from 'lucide-react';
import { useTwilioDeviceContext } from '@/components/providers/TwilioDeviceProvider';
import { formatDuration } from '@/lib/utils';

export function GlobalActiveCall() {
  const {
    callState,
    callDuration,
    isMuted,
    incomingCaller,
    activeDestination,
    activeCallContactName,
    endCall,
    toggleMute,
  } = useTwilioDeviceContext();

  // If there's an incoming call ringing, GlobalIncomingCall takes priority
  if (incomingCaller && callState === 'ringing') {
    return null;
  }

  // Only render during active/transition call states
  const isActiveCall =
    callState === 'connecting' ||
    callState === 'ringing' ||
    callState === 'connected' ||
    callState === 'ended' ||
    callState === 'failed';

  if (!isActiveCall) {
    return null;
  }

  const displayName = activeCallContactName || activeDestination || 'Active Outbound Call';
  const showSubNumber = activeCallContactName && activeDestination;

  return (
    <div className="fixed top-5 right-5 z-50 w-84 max-w-sm rounded-2xl bg-slate-900/95 border-2 border-emerald-500/80 shadow-2xl p-4 flex flex-col gap-3 backdrop-blur-md animate-in fade-in slide-in-from-top-4">
      {/* Header & Status Indicator */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="relative flex h-3 w-3">
            {callState === 'connected' ? (
              <>
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
              </>
            ) : (
              <>
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-3 w-3 bg-amber-500"></span>
              </>
            )}
          </span>
          <span className="text-xs font-bold text-slate-100 uppercase tracking-wider font-mono flex items-center gap-1.5">
            {callState === 'connected' ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
            ) : callState === 'connecting' ? (
              <Loader2 className="w-3.5 h-3.5 text-amber-400 animate-spin" />
            ) : (
              <Phone className="w-3.5 h-3.5 text-amber-400 animate-bounce" />
            )}
            <span>Outbound Call</span>
          </span>
        </div>

        <span
          className={`text-[10px] font-mono font-semibold px-2.5 py-0.5 rounded-full border ${
            callState === 'connected'
              ? 'bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-950/90 dark:border-emerald-700 dark:text-emerald-300'
              : callState === 'connecting' || callState === 'ringing'
              ? 'bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-950/90 dark:border-amber-700 dark:text-amber-300'
              : 'bg-rose-100 text-rose-800 border-rose-300 dark:bg-rose-950/90 dark:border-rose-700 dark:text-rose-300'
          }`}
        >
          {callState === 'connected'
            ? formatDuration(callDuration)
            : callState === 'connecting'
            ? 'Connecting...'
            : callState === 'ringing'
            ? 'Ringing...'
            : callState === 'ended'
            ? 'Call Ended'
            : 'Call Failed'}
        </span>
      </div>

      {/* Contact Name & Number Info */}
      <div className="py-1">
        <h4 className="text-base font-extrabold text-slate-100 font-mono tracking-wide flex items-center gap-2 truncate">
          <User className="w-4 h-4 text-emerald-400 shrink-0" />
          <span className="truncate">{displayName}</span>
        </h4>
        {showSubNumber && (
          <p className="text-xs text-slate-400 font-mono mt-0.5 pl-6">{activeDestination}</p>
        )}
      </div>

      {/* Call Controls: Mute & Hang Up */}
      {(callState === 'connecting' || callState === 'ringing' || callState === 'connected') && (
        <div className="flex items-center gap-2.5 pt-1">
          {callState === 'connected' && (
            <Button
              variant={isMuted ? 'danger' : 'secondary'}
              size="md"
              className="flex-1 font-semibold text-xs py-2"
              onClick={toggleMute}
              title={isMuted ? 'Unmute Microphone' : 'Mute Microphone'}
            >
              {isMuted ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
              <span>{isMuted ? 'Unmute' : 'Mute'}</span>
            </Button>
          )}

          <Button
            variant="danger"
            size="md"
            className="flex-1 font-bold py-2 shadow-lg shadow-rose-600/30 active:scale-95 transition-all text-xs"
            onClick={endCall}
          >
            <PhoneOff className="w-3.5 h-3.5" />
            <span>Hang Up</span>
          </Button>
        </div>
      )}
    </div>
  );
}
