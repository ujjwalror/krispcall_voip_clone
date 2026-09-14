import React, { InputHTMLAttributes, forwardRef } from 'react';
import { cn } from '@/lib/utils';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  icon?: React.ReactNode;
  rightElement?: React.ReactNode;
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, icon, rightElement, error, type = 'text', ...props }, ref) => {
    return (
      <div className="w-full">
        <div className="relative flex items-center w-full">
          {icon && (
            <div className="absolute left-3.5 text-slate-400 pointer-events-none flex items-center justify-center">
              {icon}
            </div>
          )}
          <input
            ref={ref}
            type={type}
            className={cn(
              'w-full bg-white dark:bg-slate-950/80 text-slate-900 dark:text-slate-100 text-sm placeholder-slate-400 dark:placeholder-slate-500 rounded-lg border border-slate-200 dark:border-slate-800 px-3.5 py-2.5 outline-none transition-all duration-150',
              'focus:border-blue-600 dark:focus:border-blue-500 focus:ring-1 focus:ring-blue-600 dark:focus:ring-blue-500',
              icon && 'pl-10',
              rightElement && 'pr-10',
              error && 'border-rose-500/80 focus:border-rose-500 focus:ring-rose-500',
              className
            )}
            {...props}
          />
          {rightElement && (
            <div className="absolute right-3 flex items-center justify-center">
              {rightElement}
            </div>
          )}
        </div>
        {error && <p className="mt-1 text-xs text-rose-400 font-medium">{error}</p>}
      </div>
    );
  }
);

Input.displayName = 'Input';
