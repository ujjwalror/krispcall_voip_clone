'use client';

import React, { useState } from 'react';
import { usePathname } from 'next/navigation';
import { NAVIGATION_ITEMS } from '@/lib/constants';
import { AgentStatus } from '@/lib/types';
import { AgentStatusSelector } from './AgentStatusSelector';
import { PresenceSelector } from './PresenceSelector';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { useAuth } from '@/components/providers/AuthProvider';
import { Search, LogOut, ShieldCheck, Bell, User, Sun, Moon } from 'lucide-react';
import { useTheme } from '@/components/providers/ThemeProvider';

export function TopHeader() {
  const pathname = usePathname();
  const { profile, signOut } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [agentStatus, setAgentStatus] = useState<AgentStatus>('online');

  // Determine current active page title
  const currentNav = NAVIGATION_ITEMS.find((item) => item.href === pathname);
  const title = currentNav ? currentNav.name : 'Dashboard';

  const userName = profile?.full_name || 'Authenticated Agent';
  const userEmail = profile?.email || '';
  const userRole = profile?.role || 'agent';

  return (
    <header className="h-16 border-b border-slate-800/80 bg-slate-950/80 backdrop-blur-md px-6 flex items-center justify-between sticky top-0 z-20">
      {/* Page Title & Breadcrumbs */}
      <div className="flex items-center gap-3">
        <h2 className="text-base font-semibold text-slate-100 tracking-tight">{title}</h2>
        <span className="text-slate-700">/</span>
        <span className="text-xs text-slate-400 font-medium">Legendary Careers Workspace</span>
      </div>

      {/* Global Actions */}
      <div className="flex items-center gap-4">
        {/* Global Search Bar Placeholder */}
        <div className="relative hidden md:flex items-center">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 pointer-events-none" />
          <input
            type="text"
            placeholder="Search contacts, calls, messages... (Cmd+K)"
            readOnly
            className="w-72 bg-slate-900/90 border border-slate-800 rounded-lg text-xs text-slate-200 placeholder-slate-500 pl-9 pr-8 py-2 focus:outline-none cursor-pointer hover:border-slate-700 transition-colors"
          />
          <span className="absolute right-2.5 px-1.5 py-0.5 rounded bg-slate-800 text-[10px] text-slate-400 font-mono border border-slate-700/60">
            ⌘K
          </span>
        </div>

        {/* Theme Toggle (Light / Dark) */}
        <button
          onClick={toggleTheme}
          className="p-2 rounded-lg text-slate-400 hover:text-amber-400 hover:bg-slate-900 transition-colors"
          title={`Switch to ${theme === 'dark' ? 'Light' : 'Dark'} Mode`}
        >
          {theme === 'dark' ? (
            <Sun className="w-4 h-4 text-amber-400" />
          ) : (
            <Moon className="w-4 h-4 text-indigo-500" />
          )}
        </button>

        {/* Notifications Icon */}
        <button
          className="relative p-2 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-900 transition-colors"
          title="Notifications"
        >
          <Bell className="w-4 h-4" />
          <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-blue-500 animate-ping" />
          <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-blue-500" />
        </button>

        <div className="h-5 w-px bg-slate-800" />

        {/* Agent Presence & Heartbeat Selector */}
        <PresenceSelector />

        <div className="h-5 w-px bg-slate-800" />

        {/* User Profile */}
        <div className="flex items-center gap-3">
          <Avatar
            name={userName}
            src={profile?.avatar_url || undefined}
            status={agentStatus}
            size="md"
          />
          <div className="hidden sm:block text-left leading-tight">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-semibold text-slate-200">{userName}</span>
              <Badge variant={userRole === 'admin' ? 'purple' : 'blue'} size="sm">
                {userRole === 'admin' && <ShieldCheck className="w-2.5 h-2.5" />}
                {userRole.toUpperCase()}
              </Badge>
            </div>
            <p className="text-[10px] text-slate-400">{userEmail}</p>
          </div>

          {/* Logout Action */}
          <button
            onClick={() => signOut()}
            className="p-2 text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-colors"
            title="Log Out (Sign out from session)"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </header>
  );
}
