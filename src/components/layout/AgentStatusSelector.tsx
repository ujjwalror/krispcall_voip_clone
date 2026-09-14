'use client';

import React, { useState } from 'react';
import { AgentStatus } from '@/lib/types';
import { cn } from '@/lib/utils';
import { ChevronDown, Check } from 'lucide-react';

interface AgentStatusSelectorProps {
  currentStatus: AgentStatus;
  onStatusChange?: (status: AgentStatus) => void;
}

const STATUS_OPTIONS: { status: AgentStatus; label: string; color: string }[] = [
  { status: 'online', label: 'Online / Available', color: 'bg-emerald-500' },
  { status: 'busy', label: 'In a Call / Busy', color: 'bg-rose-500' },
  { status: 'away', label: 'Away / On Break', color: 'bg-amber-500' },
  { status: 'offline', label: 'Offline', color: 'bg-slate-500' },
];

export function AgentStatusSelector({ currentStatus, onStatusChange }: AgentStatusSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const activeOption = STATUS_OPTIONS.find((opt) => opt.status === currentStatus) || STATUS_OPTIONS[0];

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 text-xs font-medium text-slate-800 dark:text-slate-200 transition-all duration-150"
      >
        <span className={cn('w-2 h-2 rounded-full', activeOption.color)} />
        <span>{activeOption.label.split('/')[0].trim()}</span>
        <ChevronDown className={cn('w-3.5 h-3.5 text-slate-400 transition-transform duration-150', isOpen && 'rotate-180')} />
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div className="absolute right-0 mt-2 w-48 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xl p-1.5 z-50 animate-in fade-in zoom-in-95 duration-100">
            <div className="px-2 py-1 text-[10px] font-semibold tracking-wider text-slate-500 uppercase">Set Your Agent Status</div>
            {STATUS_OPTIONS.map((option) => (
              <button
                key={option.status}
                onClick={() => {
                  onStatusChange?.(option.status);
                  setIsOpen(false);
                }}
                className={cn(
                  'w-full flex items-center justify-between px-2.5 py-2 rounded-lg text-xs font-medium transition-colors',
                  currentStatus === option.status
                    ? 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-100'
                    : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/60 hover:text-slate-900 dark:hover:text-slate-100'
                )}
              >
                <div className="flex items-center gap-2">
                  <span className={cn('w-2 h-2 rounded-full', option.color)} />
                  <span>{option.label}</span>
                </div>
                {currentStatus === option.status && <Check className="w-3.5 h-3.5 text-blue-400" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
