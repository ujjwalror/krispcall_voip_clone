'use client';

import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import {
  Phone,
  Delete,
  Mic,
  MicOff,
  Volume2,
  Globe,
  Shield,
  PhoneOff,
  AlertTriangle,
  Loader2,
  CheckCircle2,
  Radio,
} from 'lucide-react';
import { formatPhoneNumber, formatDuration } from '@/lib/utils';
import { useTwilioDeviceContext } from '@/components/providers/TwilioDeviceProvider';

export function DialerWidget() {
  const [phoneNumber, setPhoneNumber] = useState('');

  const {
    deviceStatus,
    callState,
    callDuration,
    isMuted,
    errorMessage,
    identity,
    autoRecordingEnabled,
    recordCallPreference,
    incomingCaller,
    setRecordCallPreference,
    makeCall,
    endCall,
    toggleMute,
    clearError,
  } = useTwilioDeviceContext();

  const keys = [
    { num: '1', sub: '' },
    { num: '2', sub: 'ABC' },
    { num: '3', sub: 'DEF' },
    { num: '4', sub: 'GHI' },
    { num: '5', sub: 'JKL' },
    { num: '6', sub: 'MNO' },
    { num: '7', sub: 'PQRS' },
    { num: '8', sub: 'TUV' },
    { num: '9', sub: 'WXYZ' },
    { num: '*', sub: '' },
    { num: '0', sub: '+' },
    { num: '#', sub: '' },
  ];

  const handleKeyPress = (char: string) => {
    setPhoneNumber((prev) => prev + char);
  };

  const handleBackspace = () => {
    setPhoneNumber((prev) => prev.slice(0, -1));
  };

  const handleStartCall = async () => {
    if (!phoneNumber) return;
    await makeCall(phoneNumber);
  };

  const isCallActive = callState === 'connecting' || callState === 'ringing' || callState === 'connected';

  return (
    <div className="w-full max-w-sm mx-auto rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl p-5 flex flex-col gap-4">
      {/* Dialer Header */}
      <div className="flex items-center justify-between pb-3 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <Badge variant="blue" size="sm">
            <Globe className="w-3 h-3" />
            Twilio PSTN
          </Badge>
          {identity && (
            <span className="text-[11px] text-slate-400 font-mono">Agent: {identity}</span>
          )}
        </div>

        {/* Device Status Indicator */}
        {deviceStatus === 'ready' && (
          <Badge variant="emerald" size="sm">
            <Shield className="w-2.5 h-2.5" />
            WebRTC Ready
          </Badge>
        )}
        {deviceStatus === 'initializing' && (
          <Badge variant="amber" pulse size="sm">
            <Loader2 className="w-2.5 h-2.5 animate-spin" />
            Initializing...
          </Badge>
        )}
        {deviceStatus === 'error' && (
          <Badge variant="rose" size="sm">
            <AlertTriangle className="w-2.5 h-2.5" />
            Unconfigured
          </Badge>
        )}
      </div>

      {/* Per-Call Recording Override Controls */}
      <div className="flex items-center justify-between px-3 py-2 rounded-xl bg-slate-950/60 border border-slate-800/80 text-xs">
        <div className="flex items-center gap-2">
          <Radio className={`w-3.5 h-3.5 ${recordCallPreference ? 'text-rose-400 animate-pulse' : 'text-slate-500'}`} />
          <span className="text-slate-300 font-medium text-[11px]">
            Call Recording: <strong className={recordCallPreference ? 'text-rose-400' : 'text-slate-400'}>{recordCallPreference ? 'ON' : 'OFF'}</strong>
          </span>
        </div>
        <button
          onClick={() => setRecordCallPreference(!recordCallPreference)}
          disabled={isCallActive}
          title={`Workspace default is ${autoRecordingEnabled ? 'Auto-Record ON' : 'Auto-Record OFF'}. Click to toggle for this call.`}
          className={`px-2.5 py-1 rounded-lg text-[10px] font-bold tracking-wider uppercase transition-colors border ${
            recordCallPreference
              ? 'bg-rose-950/80 border-rose-600/80 text-rose-300 hover:bg-rose-900/80'
              : 'bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-700 hover:text-slate-200'
          }`}
        >
          {recordCallPreference ? 'Disable REC' : 'Enable REC'}
        </button>
      </div>

      {/* Call State Alert Banner */}
      {callState !== 'idle' && !incomingCaller && (
        <div
          className={`p-3 rounded-xl border flex items-center justify-between text-xs font-medium ${
            callState === 'connected'
              ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-300'
              : callState === 'connecting' || callState === 'ringing'
              ? 'bg-amber-950/40 border-amber-500/40 text-amber-300'
              : callState === 'permission_denied' || callState === 'failed'
              ? 'bg-rose-950/40 border-rose-500/40 text-rose-300'
              : 'bg-slate-950/40 border-slate-800 text-slate-300'
          }`}
        >
          <div className="flex items-center gap-2">
            {callState === 'connecting' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {callState === 'ringing' && <Phone className="w-3.5 h-3.5 animate-bounce" />}
            {callState === 'connected' && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />}
            {callState === 'permission_denied' && <MicOff className="w-3.5 h-3.5 text-rose-400" />}
            <span className="capitalize">
              {callState === 'permission_denied'
                ? 'Mic Permission Denied'
                : callState === 'connected'
                ? `Connected (${formatDuration(callDuration)})`
                : callState}
            </span>
          </div>

          {callState === 'connected' && (
            <button
              onClick={toggleMute}
              className={`p-1.5 rounded-lg border transition-colors ${
                isMuted
                  ? 'bg-rose-900/60 border-rose-500 text-rose-200'
                  : 'bg-slate-800 border-slate-700 text-slate-200 hover:bg-slate-700'
              }`}
              title={isMuted ? 'Unmute microphone' : 'Mute microphone'}
            >
              {isMuted ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
            </button>
          )}
        </div>
      )}

      {/* Error Alert Display */}
      {errorMessage && (
        <div className="p-2.5 rounded-xl bg-rose-950/60 border border-rose-800/80 text-[11px] text-rose-200 flex items-start justify-between">
          <div className="flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0 mt-0.5" />
            <span>{errorMessage}</span>
          </div>
          <button onClick={clearError} className="text-rose-400 hover:text-rose-200 ml-2">
            ✕
          </button>
        </div>
      )}

      {/* Number Display Input */}
      <div className="relative">
        <Input
          type="text"
          value={phoneNumber}
          onChange={(e) => setPhoneNumber(e.target.value)}
          placeholder="Enter phone number..."
          disabled={isCallActive}
          className="text-center text-lg font-mono tracking-wider font-semibold py-3 bg-slate-950/90"
        />
        {phoneNumber && !isCallActive && (
          <button
            onClick={handleBackspace}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200 p-1"
            title="Delete character"
          >
            <Delete className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* DTMF Keypad Grid */}
      <div className="grid grid-cols-3 gap-2.5 my-1">
        {keys.map((key) => (
          <button
            key={key.num}
            onClick={() => handleKeyPress(key.num)}
            className="flex flex-col items-center justify-center h-14 rounded-xl bg-slate-950/60 hover:bg-slate-800/80 border border-slate-800/80 active:bg-blue-600/20 active:border-blue-500/40 transition-all duration-100 group"
          >
            <span className="text-base font-semibold text-slate-100 group-hover:scale-105 transition-transform">
              {key.num}
            </span>
            {key.sub && <span className="text-[9px] font-medium text-slate-500">{key.sub}</span>}
          </button>
        ))}
      </div>

      {/* Call Actions */}
      <div className="flex items-center gap-3 pt-2">
        {!isCallActive ? (
          <Button
            variant="success"
            size="lg"
            className="w-full font-semibold py-3"
            disabled={!phoneNumber || deviceStatus === 'initializing'}
            onClick={handleStartCall}
          >
            <Phone className="w-4 h-4" />
            <span>Call Number</span>
          </Button>
        ) : (
          <Button
            variant="danger"
            size="lg"
            className="w-full font-semibold py-3"
            onClick={endCall}
          >
            <PhoneOff className="w-4 h-4" />
            <span>End Call</span>
          </Button>
        )}
      </div>

      {/* Device Status Controls */}
      <div className="flex items-center justify-between text-[11px] text-slate-400 px-1 pt-2 border-t border-slate-800/80">
        <div className="flex items-center gap-1.5">
          <Mic className="w-3.5 h-3.5 text-emerald-400" />
          <span>Microphone Ready</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Volume2 className="w-3.5 h-3.5 text-blue-400" />
          <span>Speaker Output</span>
        </div>
      </div>
    </div>
  );
}
