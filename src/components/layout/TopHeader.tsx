'use client';

import React, { useState } from 'react';
import { usePathname } from 'next/navigation';
import { NAVIGATION_ITEMS } from '@/lib/constants';
import { AgentStatus } from '@/lib/types';
import { PresenceSelector } from './PresenceSelector';
import { SidebarNavItems } from './Sidebar';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { useAuth } from '@/components/providers/AuthProvider';
import { Search, LogOut, ShieldCheck, Bell, Sun, Moon, Menu, X, Radio, Sparkles } from 'lucide-react';
import { useTheme } from '@/components/providers/ThemeProvider';

export function TopHeader() {
  const pathname = usePathname();
  const { profile, signOut } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [agentStatus] = useState<AgentStatus>('online');
  const [isMobileDrawerOpen, setIsMobileDrawerOpen] = useState(false);

  const currentNav = NAVIGATION_ITEMS.find((item) => item.href === pathname);
  const title = currentNav ? currentNav.name : 'Dashboard';

  const userName = profile?.full_name || 'Authenticated Agent';
  const userEmail = profile?.email || '';
  const userRole = profile?.role || 'agent';

  return (
    <>
      <header className="h-16 border-b border-slate-200 dark:border-slate-800/80 bg-white/90 dark:bg-slate-950/80 backdrop-blur-md px-4 sm:px-6 flex items-center justify-between sticky top-0 z-20 w-full transition-colors">
        {/* Mobile Header: Hamburger Menu + Page Title / Brand */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => setIsMobileDrawerOpen(true)}
            className="p-2 -ml-1.5 rounded-xl text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-900 lg:hidden transition-colors"
            title="Open Navigation Menu"
          >
            <Menu className="w-5 h-5" />
          </button>

          <div className="flex items-center gap-2 lg:hidden">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-tr from-blue-600 to-indigo-600 flex items-center justify-center text-white shadow-xs">
              <Radio className="w-4 h-4" />
            </div>
            <span className="font-bold text-sm text-slate-900 dark:text-slate-100 tracking-tight">VoIP Hub</span>
          </div>

          <div className="hidden lg:flex items-center gap-3">
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100 tracking-tight">{title}</h2>
            <span className="text-slate-300 dark:text-slate-700">/</span>
            <span className="text-xs text-slate-500 dark:text-slate-400 font-medium">Legendary Careers Workspace</span>
          </div>
        </div>

        {/* Global Actions Header Row */}
        <div className="flex items-center gap-2 sm:gap-4">
          {/* Global Search Bar (Desktop / Tablet) */}
          <div className="relative hidden xl:flex items-center">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 pointer-events-none" />
            <input
              type="text"
              placeholder="Search contacts, calls, messages... (Cmd+K)"
              readOnly
              className="w-64 bg-slate-100 dark:bg-slate-900/90 border border-slate-200 dark:border-slate-800 rounded-lg text-xs text-slate-900 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-500 pl-9 pr-8 py-2 focus:outline-none cursor-pointer hover:border-slate-300 dark:hover:border-slate-700 transition-colors"
            />
            <span className="absolute right-2.5 px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-800 text-[10px] text-slate-500 dark:text-slate-400 font-mono border border-slate-300 dark:border-slate-700/60">
              ⌘K
            </span>
          </div>

          {/* Theme Toggle (Light / Dark) */}
          <button
            onClick={toggleTheme}
            className="p-2 rounded-xl text-slate-600 dark:text-slate-400 hover:text-amber-500 dark:hover:text-amber-400 hover:bg-slate-100 dark:hover:bg-slate-900 transition-colors"
            title={`Switch to ${theme === 'dark' ? 'Light' : 'Dark'} Mode`}
          >
            {theme === 'dark' ? (
              <Sun className="w-4 h-4 text-amber-400" />
            ) : (
              <Moon className="w-4 h-4 text-indigo-600" />
            )}
          </button>

          {/* Notifications Icon (Hidden on very small mobile if space is tight) */}
          <button
            className="relative p-2 rounded-xl text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-900 transition-colors hidden sm:block"
            title="Notifications"
          >
            <Bell className="w-4 h-4" />
            <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-blue-500 animate-ping" />
            <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-blue-500" />
          </button>

          <div className="h-5 w-px bg-slate-200 dark:bg-slate-800 hidden sm:block" />

          {/* Agent Presence & Heartbeat Selector */}
          <PresenceSelector />

          <div className="h-5 w-px bg-slate-200 dark:bg-slate-800" />

          {/* User Profile */}
          <div className="flex items-center gap-2.5">
            <Avatar
              name={userName}
              src={profile?.avatar_url || undefined}
              status={agentStatus}
              size="md"
            />
            <div className="hidden md:block text-left leading-tight">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-semibold text-slate-900 dark:text-slate-200">{userName}</span>
                <Badge variant={userRole === 'admin' ? 'purple' : 'blue'} size="sm">
                  {userRole === 'admin' && <ShieldCheck className="w-2.5 h-2.5" />}
                  {userRole.toUpperCase()}
                </Badge>
              </div>
              <p className="text-[10px] text-slate-500 dark:text-slate-400">{userEmail}</p>
            </div>

            {/* Logout Action */}
            <button
              onClick={() => signOut()}
              className="p-2 text-slate-500 dark:text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-500/10 rounded-xl transition-colors"
              title="Log Out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Mobile Navigation Slide-Over Drawer */}
      {isMobileDrawerOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          {/* Dark Backdrop */}
          <div
            className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm animate-in fade-in transition-opacity"
            onClick={() => setIsMobileDrawerOpen(false)}
          />

          {/* Drawer Content */}
          <div className="relative w-72 max-w-[85vw] bg-white dark:bg-slate-950 border-r border-slate-200 dark:border-slate-800 h-full flex flex-col shadow-2xl z-10 animate-in slide-in-from-left duration-200">
            {/* Drawer Header */}
            <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-blue-600 to-cyan-500 flex items-center justify-center text-white shadow-xs">
                  <Radio className="w-4 h-4 animate-pulse" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
                    <span>VoIP Hub</span>
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400 font-semibold border border-blue-500/20">
                      INTERNAL
                    </span>
                  </h3>
                  <p className="text-[10px] text-slate-500 dark:text-slate-400">Legendary Careers</p>
                </div>
              </div>

              <button
                onClick={() => setIsMobileDrawerOpen(false)}
                className="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                title="Close Navigation Menu"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Drawer Navigation List */}
            <SidebarNavItems onNavigate={() => setIsMobileDrawerOpen(false)} />

            {/* Drawer Footer */}
            <div className="p-3 border-t border-slate-200 dark:border-slate-800">
              <div className="p-3 rounded-xl bg-slate-100 dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 flex items-center gap-2.5">
                <Sparkles className="w-4 h-4 text-cyan-500 shrink-0" />
                <div className="text-[11px] leading-tight">
                  <p className="font-medium text-slate-900 dark:text-slate-200">Legendary Careers</p>
                  <p className="text-slate-500">Internal Staff Portal</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
