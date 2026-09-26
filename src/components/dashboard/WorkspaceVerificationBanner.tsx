'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { CustomerWorkspaceVerificationStatus } from '@/lib/telephony/verification/types';

/**
 * PHASE 11.3D — WORKSPACE VERIFICATION BANNER
 * Lightweight, non-disruptive banner for workspace trust/identity status on dashboard.
 * Explicitly distinguishes Workspace Account Verification from Phone-Number Compliance.
 */
export function WorkspaceVerificationBanner() {
  const [statusData, setStatusData] = useState<CustomerWorkspaceVerificationStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchStatus() {
      try {
        const res = await fetch('/api/workspace-verification');
        if (res.ok) {
          const json = await res.json();
          if (json.success) {
            setStatusData(json.data);
          }
        }
      } catch (err) {
        console.error('Failed to load workspace verification status banner:', err);
      } finally {
        setLoading(false);
      }
    }
    fetchStatus();
  }, []);

  if (loading || !statusData) {
    return null;
  }

  // If verified, show a small discrete badge instead of full banner
  if (statusData.status === 'verified') {
    return (
      <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-4 py-2.5 flex items-center justify-between text-xs text-emerald-400 mb-6">
        <div className="flex items-center space-x-2">
          <svg className="w-4 h-4 text-emerald-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
          </svg>
          <span className="font-semibold">Account Verified</span>
          <span className="text-emerald-500/80">• Workspace identity verification active</span>
        </div>
        <Link href="/settings/verification" className="underline hover:text-emerald-300 transition-colors">
          View details
        </Link>
      </div>
    );
  }

  const getTheme = () => {
    switch (statusData.status) {
      case 'under_review':
        return {
          bg: 'bg-amber-500/10 border-amber-500/20 text-amber-200',
          badge: 'bg-amber-500/20 text-amber-300',
          button: 'bg-amber-600 hover:bg-amber-500 text-white',
        };
      case 'action_required':
      case 'rejected':
        return {
          bg: 'bg-rose-500/10 border-rose-500/20 text-rose-200',
          badge: 'bg-rose-500/20 text-rose-300',
          button: 'bg-rose-600 hover:bg-rose-500 text-white',
        };
      default:
        return {
          bg: 'bg-blue-500/10 border-blue-500/20 text-blue-200',
          badge: 'bg-blue-500/20 text-blue-300',
          button: 'bg-blue-600 hover:bg-blue-500 text-white',
        };
    }
  };

  const theme = getTheme();

  return (
    <div className={`${theme.bg} border rounded-xl p-4 mb-6 transition-all`}>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center space-x-2">
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full uppercase tracking-wider ${theme.badge}`}>
              Account Verification
            </span>
            <h4 className="text-sm font-semibold text-white">{statusData.headline}</h4>
          </div>
          <p className="text-xs text-slate-300">{statusData.description}</p>
          <p className="text-[11px] text-slate-400">
            Note: Account Verification establishes workspace platform trust and is distinct from Phone-Number Regulatory Bundles.
          </p>
        </div>
        <div>
          <Link
            href="/settings/verification"
            className={`inline-block px-4 py-2 text-xs font-medium rounded-lg shadow-sm transition-colors whitespace-nowrap ${theme.button}`}
          >
            {statusData.can_initiate ? 'Manage Verification' : 'View Status'}
          </Link>
        </div>
      </div>
    </div>
  );
}
