import React from 'react';
import { cn } from '@/lib/utils';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  hoverable?: boolean;
}

export function Card({ className, hoverable = false, children, ...props }: CardProps) {
  return (
    <div
      className={cn(
        'rounded-xl border border-slate-200 dark:border-slate-800/80 bg-white dark:bg-slate-900/90 p-5 shadow-xs dark:shadow-xl transition-all duration-200 text-slate-900 dark:text-slate-100',
        hoverable && 'hover:border-slate-300 dark:hover:border-slate-700 hover:shadow-md dark:hover:shadow-2xl',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('flex items-center justify-between pb-4 border-b border-slate-100 dark:border-slate-800/80 mb-4', className)} {...props}>
      {children}
    </div>
  );
}

export function CardTitle({ className, children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3 className={cn('text-lg font-semibold text-slate-900 dark:text-slate-100 tracking-tight', className)} {...props}>
      {children}
    </h3>
  );
}
