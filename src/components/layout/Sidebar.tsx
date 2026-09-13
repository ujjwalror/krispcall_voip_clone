'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NAVIGATION_ITEMS } from '@/lib/constants';
import { cn } from '@/lib/utils';
import { useAuth } from '@/components/providers/AuthProvider';
import { PhoneCall, Radio, Sparkles } from 'lucide-react';

interface SidebarNavProps {
  onNavigate?: () => void;
}

export function SidebarNavItems({ onNavigate }: SidebarNavProps) {
  const pathname = usePathname();
  const { profile } = useAuth();
  const isAdminUser = profile?.role === 'admin';

  const mainItems = NAVIGATION_ITEMS.filter((item) => item.category === 'main');
  const adminItems = NAVIGATION_ITEMS.filter((item) => {
    if (item.category !== 'admin') return false;
    if (item.href === '/admin' && !isAdminUser) return false;
    return true;
  });

  const activeNavHref = React.useMemo(() => {
    const matches = NAVIGATION_ITEMS.filter(
      (item) => pathname === item.href || pathname.startsWith(`${item.href}/`)
    );
    if (matches.length === 0) return null;
    matches.sort((a, b) => b.href.length - a.href.length);
    return matches[0].href;
  }, [pathname]);

  return (
    <div className="flex-1 overflow-y-auto px-3 py-2 space-y-6">
      {/* Quick Launch Phone Button */}
      <div className="pt-1 pb-2">
        <Link
          href="/phone"
          onClick={onNavigate}
          className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-lg shadow-blue-600/25 transition-all duration-150 active:scale-[0.98]"
        >
          <PhoneCall className="w-4 h-4" />
          <span>Open Phone Dialer</span>
        </Link>
      </div>

      {/* Main Navigation */}
      <div>
        <div className="px-3 mb-2 text-[10px] font-bold tracking-wider text-slate-500 dark:text-slate-400 uppercase">
          Communication
        </div>
        <nav className="space-y-1">
          {mainItems.map((item) => {
            const Icon = item.icon;
            const isActive = item.href === activeNavHref;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                className={cn(
                  'flex items-center justify-between px-3 py-2.5 rounded-lg text-xs font-medium transition-all duration-150 group',
                  isActive
                    ? 'bg-blue-600/15 text-blue-600 dark:text-blue-400 font-semibold border border-blue-500/20'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-900/80'
                )}
              >
                <div className="flex items-center gap-3">
                  <Icon
                    className={cn(
                      'w-4 h-4 transition-colors',
                      isActive ? 'text-blue-600 dark:text-blue-400' : 'text-slate-500 dark:text-slate-400 group-hover:text-slate-900 dark:group-hover:text-slate-200'
                    )}
                  />
                  <span>{item.name}</span>
                </div>
                {item.badge && (
                  <span
                    className={cn(
                      'px-2 py-0.5 rounded-full text-[10px] font-bold',
                      isActive ? 'bg-blue-600 text-white' : 'bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
                    )}
                  >
                    {item.badge}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
      </div>

      {/* Administration & Preferences Navigation */}
      <div>
        <div className="px-3 mb-2 text-[10px] font-bold tracking-wider text-slate-500 dark:text-slate-400 uppercase">
          Preferences
        </div>
        <nav className="space-y-1">
          {adminItems.map((item) => {
            const Icon = item.icon;
            const isActive = item.href === activeNavHref;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                className={cn(
                  'flex items-center justify-between px-3 py-2.5 rounded-lg text-xs font-medium transition-all duration-150 group',
                  isActive
                    ? 'bg-blue-600/15 text-blue-600 dark:text-blue-400 font-semibold border border-blue-500/20'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-900/80'
                )}
              >
                <div className="flex items-center gap-3">
                  <Icon
                    className={cn(
                      'w-4 h-4 transition-colors',
                      isActive ? 'text-blue-600 dark:text-blue-400' : 'text-slate-500 dark:text-slate-400 group-hover:text-slate-900 dark:group-hover:text-slate-200'
                    )}
                  />
                  <span>{item.name}</span>
                </div>
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}

export function Sidebar() {
  return (
    <aside className="hidden lg:flex w-64 bg-slate-950/95 border-r border-slate-800/80 flex-col h-screen sticky top-0 z-30 select-none backdrop-blur-xl shrink-0">
      {/* Brand Header */}
      <div className="p-4 border-b border-slate-800/80 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-blue-600 via-indigo-600 to-cyan-500 flex items-center justify-center text-white shadow-lg shadow-blue-500/20">
            <Radio className="w-5 h-5 animate-pulse" />
          </div>
          <div>
            <h1 className="text-sm font-bold text-slate-100 tracking-tight flex items-center gap-1.5">
              <span>VoIP Hub</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 font-semibold border border-blue-500/20">
                INTERNAL
              </span>
            </h1>
            <p className="text-[11px] text-slate-400 font-medium">Legendary Careers</p>
          </div>
        </div>
      </div>

      {/* Navigation Groups */}
      <SidebarNavItems />

      {/* Internal System Footer Banner */}
      <div className="p-3 border-t border-slate-800/80">
        <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800 flex items-center gap-2.5">
          <Sparkles className="w-4 h-4 text-cyan-400 shrink-0" />
          <div className="text-[11px] leading-tight">
            <p className="font-medium text-slate-200">Legendary Careers</p>
            <p className="text-slate-500">Internal Staff Portal</p>
          </div>
        </div>
      </div>
    </aside>
  );
}
