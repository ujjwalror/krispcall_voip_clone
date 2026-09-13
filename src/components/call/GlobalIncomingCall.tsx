'use client';

import React from 'react';
import { Button } from '@/components/ui/Button';
import { Phone, PhoneOff } from 'lucide-react';
import { useTwilioDeviceContext } from '@/components/providers/TwilioDeviceProvider';

export function GlobalIncomingCall() {
  const { incomingCaller, callState, acceptIncomingCall, rejectIncomingCall } =
    useTwilioDeviceContext();

  if (!incomingCaller || callState !== 'ringing') {
    return null;
  }

  return (
    <div className="fixed top-3 left-3 right-3 sm:left-auto sm:right-5 sm:top-5 z-[9999] w-auto sm:w-96 max-w-full sm:max-w-sm rounded-2xl bg-slate-900 border-2 border-blue-500 shadow-2xl p-4 flex flex-col gap-3 backdrop-blur-md animate-in fade-in slide-in-from-top-4">
      {/* Header Badge */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="relative flex h-3 w-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-3 w-3 bg-blue-500"></span>
          </span>
          <Phone className="w-4 h-4 text-blue-400 animate-pulse" />
          <span className="text-xs font-bold text-slate-100 uppercase tracking-wider font-mono">
            Incoming Call
          </span>
        </div>
        <span className="text-[10px] text-blue-600 dark:text-blue-300 font-mono font-semibold animate-pulse px-2.5 py-0.5 rounded-full bg-blue-100 dark:bg-blue-950/80 border border-blue-300 dark:border-blue-800/60">
          Ringing...
        </span>
      </div>

      {/* Caller Info */}
      <div className="py-1">
        <h4 className="text-lg font-extrabold text-slate-100 font-mono tracking-wide">
          {incomingCaller}
        </h4>
        <p className="text-xs text-slate-400 font-medium">Customer calling company number</p>
      </div>

      {/* Action Buttons */}
      <div className="flex items-center gap-2.5 pt-1">
        <Button
          variant="success"
          size="md"
          className="flex-1 font-bold py-2.5 shadow-lg shadow-emerald-600/30 active:scale-95 transition-all"
          onClick={acceptIncomingCall}
        >
          <Phone className="w-4 h-4" />
          <span>Accept</span>
        </Button>
        <Button
          variant="danger"
          size="md"
          className="flex-1 font-bold py-2.5 shadow-lg shadow-rose-600/30 active:scale-95 transition-all"
          onClick={rejectIncomingCall}
        >
          <PhoneOff className="w-4 h-4" />
          <span>Reject</span>
        </Button>
      </div>
    </div>
  );
}
