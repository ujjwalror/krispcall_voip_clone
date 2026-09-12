import React from 'react';
import { Sidebar } from '@/components/layout/Sidebar';
import { TopHeader } from '@/components/layout/TopHeader';
import { TwilioDeviceProvider } from '@/components/providers/TwilioDeviceProvider';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <TwilioDeviceProvider>
      <div className="flex min-h-screen bg-slate-950 text-slate-100 antialiased selection:bg-blue-500 selection:text-white">
        {/* Persistent Navigation Sidebar */}
        <Sidebar />

        {/* Main Workspace Area */}
        <div className="flex-1 flex flex-col min-w-0">
          <TopHeader />
          <main className="flex-1 p-6 overflow-y-auto">{children}</main>
        </div>
      </div>
    </TwilioDeviceProvider>
  );
}
