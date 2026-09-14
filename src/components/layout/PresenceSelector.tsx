'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Circle, ChevronDown, Check, UserCheck, UserX, Clock } from 'lucide-react';

export type AvailabilityStatus = 'available' | 'busy' | 'offline';

export function PresenceSelector() {
  const [status, setStatus] = useState<AvailabilityStatus>('available');
  const [isOpen, setIsOpen] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);

  const sendHeartbeat = useCallback(async (newStatus?: AvailabilityStatus) => {
    try {
      const res = await fetch('/api/users/presence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus || status }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.profile?.availability_status) {
          setStatus(data.profile.availability_status);
        }
      }
    } catch (err) {
      console.warn('[PresenceSelector] Heartbeat failed:', err);
    }
  }, [status]);

  // Initial fetch and 30s periodic heartbeat
  useEffect(() => {
    // Initial fetch
    fetch('/api/users/presence')
      .then((res) => res.json())
      .then((data) => {
        if (data.currentStatus) {
          setStatus(data.currentStatus as AvailabilityStatus);
        }
      })
      .catch(() => {});

    // Periodic heartbeat every 30 seconds
    const interval = setInterval(() => {
      sendHeartbeat();
    }, 30000);

    return () => clearInterval(interval);
  }, [sendHeartbeat]);

  const handleStatusChange = async (newStatus: AvailabilityStatus) => {
    setIsUpdating(true);
    setStatus(newStatus);
    setIsOpen(false);
    await sendHeartbeat(newStatus);
    setIsUpdating(false);
  };

  const getStatusBadge = (s: AvailabilityStatus) => {
    switch (s) {
      case 'available':
        return {
          label: 'Available',
          color: 'bg-emerald-500',
          text: 'text-emerald-400',
          bg: 'bg-emerald-500/10 border-emerald-500/20',
          icon: Circle,
        };
      case 'busy':
        return {
          label: 'Busy / On Call',
          color: 'bg-amber-500',
          text: 'text-amber-400',
          bg: 'bg-amber-500/10 border-amber-500/20',
          icon: Circle,
        };
      case 'offline':
      default:
        return {
          label: 'Offline',
          color: 'bg-slate-500',
          text: 'text-slate-400',
          bg: 'bg-slate-500/10 border-slate-500/20',
          icon: Circle,
        };
    }
  };

  const currentBadge = getStatusBadge(status);

  return (
    <div className="relative inline-block text-left">
      <button
        onClick={() => setIsOpen(!isOpen)}
        disabled={isUpdating}
        className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border text-xs font-medium transition-all backdrop-blur-md ${currentBadge.bg} ${currentBadge.text} hover:border-slate-600`}
        title="Change Availability Status"
      >
        <span className="relative flex h-2 w-2">
          {status === 'available' && (
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
          )}
          <span className={`relative inline-flex rounded-full h-2 w-2 ${currentBadge.color}`} />
        </span>
        <span className="font-mono text-[11px] uppercase tracking-wider">{currentBadge.label}</span>
        <ChevronDown className="w-3 h-3 text-slate-400 ml-0.5" />
      </button>

      {isOpen && (
        <div className="origin-top-right absolute right-0 mt-2 w-48 rounded-xl shadow-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 z-50 p-1 space-y-0.5">
          <button
            onClick={() => handleStatusChange('available')}
            className={`w-full flex items-center justify-between px-3 py-2 text-xs rounded-lg transition-colors ${
              status === 'available' ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 font-semibold' : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
          >
            <span className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              Available for Calls
            </span>
            {status === 'available' && <Check className="w-3.5 h-3.5" />}
          </button>

          <button
            onClick={() => handleStatusChange('busy')}
            className={`w-full flex items-center justify-between px-3 py-2 text-xs rounded-lg transition-colors ${
              status === 'busy' ? 'bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400 font-semibold' : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
          >
            <span className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-amber-500" />
              Busy / In Meeting
            </span>
            {status === 'busy' && <Check className="w-3.5 h-3.5" />}
          </button>

          <button
            onClick={() => handleStatusChange('offline')}
            className={`w-full flex items-center justify-between px-3 py-2 text-xs rounded-lg transition-colors ${
              status === 'offline' ? 'bg-slate-100 dark:bg-slate-500/10 text-slate-700 dark:text-slate-400 font-semibold' : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
          >
            <span className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-slate-500" />
              Offline
            </span>
            {status === 'offline' && <Check className="w-3.5 h-3.5" />}
          </button>
        </div>
      )}
    </div>
  );
}
