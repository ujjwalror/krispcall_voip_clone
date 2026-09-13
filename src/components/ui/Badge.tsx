import React from 'react';
import { cn } from '@/lib/utils';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: 'blue' | 'emerald' | 'amber' | 'rose' | 'purple' | 'neutral';
  size?: 'sm' | 'md';
  pulse?: boolean;
}

export function Badge({
  className,
  variant = 'neutral',
  size = 'md',
  pulse = false,
  children,
  ...props
}: BadgeProps) {
  const variants = {
    blue: 'bg-blue-100 text-blue-800 border-blue-300 dark:bg-blue-500/10 dark:text-blue-400 dark:border-blue-500/20',
    emerald: 'bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-500/10 dark:text-emerald-400 dark:border-emerald-500/20',
    amber: 'bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-500/10 dark:text-amber-400 dark:border-amber-500/20',
    rose: 'bg-rose-100 text-rose-800 border-rose-300 dark:bg-rose-500/10 dark:text-rose-400 dark:border-rose-500/20',
    purple: 'bg-purple-100 text-purple-800 border-purple-300 dark:bg-purple-500/10 dark:text-purple-400 dark:border-purple-500/20',
    neutral: 'bg-slate-200 text-slate-800 border-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700/60',
  };

  const sizes = {
    sm: 'text-[10px] px-1.5 py-0.5 font-semibold',
    md: 'text-xs px-2.5 py-1 font-medium',
  };

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border tracking-wide uppercase',
        variants[variant],
        sizes[size],
        className
      )}
      {...props}
    >
      {pulse && (
        <span className="relative flex h-1.5 w-1.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 bg-current"></span>
          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-current"></span>
        </span>
      )}
      {children}
    </span>
  );
}
