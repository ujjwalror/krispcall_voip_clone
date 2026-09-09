import React from 'react';
import { cn } from '@/lib/utils';
import { AgentStatus } from '@/lib/types';

export interface AvatarProps {
  name: string;
  src?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  status?: AgentStatus;
  className?: string;
}

export function Avatar({ name, src, size = 'md', status, className }: AvatarProps) {
  const initials = name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  const sizes = {
    sm: 'w-7 h-7 text-xs',
    md: 'w-9 h-9 text-sm',
    lg: 'w-11 h-11 text-base',
    xl: 'w-14 h-14 text-lg',
  };

  const statusDotSizes = {
    sm: 'w-2 h-2',
    md: 'w-2.5 h-2.5',
    lg: 'w-3 h-3',
    xl: 'w-3.5 h-3.5',
  };

  const statusColors = {
    online: 'bg-emerald-500 status-glow-online',
    busy: 'bg-rose-500 status-glow-busy',
    away: 'bg-amber-500 status-glow-away',
    offline: 'bg-slate-500',
  };

  return (
    <div className="relative inline-block select-none">
      <div
        className={cn(
          'relative flex items-center justify-center rounded-full overflow-hidden bg-slate-800 border border-slate-700/60 font-semibold text-slate-200 shadow-md',
          sizes[size],
          className
        )}
      >
        {src ? (
          <img src={src} alt={name} className="w-full h-full object-cover" />
        ) : (
          <span>{initials}</span>
        )}
      </div>

      {status && (
        <span
          className={cn(
            'absolute bottom-0 right-0 rounded-full ring-2 ring-slate-950',
            statusDotSizes[size],
            statusColors[status]
          )}
          title={`Status: ${status}`}
        />
      )}
    </div>
  );
}
