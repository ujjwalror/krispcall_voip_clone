'use client';

import React, { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { Phone, Delete, Mic, Volume2, Globe, Shield, PhoneOff } from 'lucide-react';
import { formatPhoneNumber } from '@/lib/utils';

export function DialerWidget() {
  const [phoneNumber, setPhoneNumber] = useState('');
  const [isCalling, setIsCalling] = useState(false);
  const [callDuration, setCallDuration] = useState(0);

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

  return (
    <div className="w-full max-w-sm mx-auto rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl p-5 flex flex-col gap-4">
      {/* Dialer Header */}
      <div className="flex items-center justify-between pb-3 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <Badge variant="blue" size="sm">
            <Globe className="w-3 h-3" />
            Twilio PSTN
          </Badge>
          <span className="text-[11px] text-slate-400 font-mono">From: +1 (800) 555-0199</span>
        </div>
        <Badge variant="emerald" size="sm">
          <Shield className="w-2.5 h-2.5" />
          WebRTC Ready
        </Badge>
      </div>

      {/* Number Display Input */}
      <div className="relative">
        <Input
          type="text"
          value={formatPhoneNumber(phoneNumber)}
          onChange={(e) => setPhoneNumber(e.target.value)}
          placeholder="Enter phone number..."
          className="text-center text-lg font-mono tracking-wider font-semibold py-3 bg-slate-950/90"
        />
        {phoneNumber && (
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
        {!isCalling ? (
          <Button
            variant="success"
            size="lg"
            className="w-full font-semibold py-3"
            disabled={!phoneNumber}
            onClick={() => setIsCalling(true)}
          >
            <Phone className="w-4 h-4" />
            <span>Call Number</span>
          </Button>
        ) : (
          <Button
            variant="danger"
            size="lg"
            className="w-full font-semibold py-3"
            onClick={() => setIsCalling(false)}
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
          <span>Default Microphone</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Volume2 className="w-3.5 h-3.5 text-blue-400" />
          <span>Default Speaker</span>
        </div>
      </div>
    </div>
  );
}
