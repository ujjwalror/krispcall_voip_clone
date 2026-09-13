import React from 'react';
import { Sidebar } from '@/components/layout/Sidebar';
import { TopHeader } from '@/components/layout/TopHeader';
import { TwilioDeviceProvider } from '@/components/providers/TwilioDeviceProvider';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <TwilioDeviceProvider>
      <div className="flex flex-col lg:flex-row min-h-screen min-h-dvh bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 antialiased selection:bg-blue-500 selection:text-white transition-colors">
        {/* Persistent Navigation Sidebar (Desktop Only) */}
        <Sidebar />

        {/* Main Workspace Area */}
        <div className="flex-1 flex flex-col min-w-0 w-full">
          <TopHeader />
          <main className="flex-1 p-3.5 sm:p-5 md:p-6 overflow-y-auto w-full max-w-full min-w-0">{children}</main>
        </div>
      </div>
    </TwilioDeviceProvider>
  );
}
