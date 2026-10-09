'use client';

import React, { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

export default function SettingsIvrRedirectPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/settings?tab=ivr');
  }, [router]);

  return (
    <div className="p-12 text-center text-xs text-slate-500 dark:text-slate-400">
      <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2 text-blue-500" />
      <span>Redirecting to IVR Phone Menu Settings...</span>
    </div>
  );
}
