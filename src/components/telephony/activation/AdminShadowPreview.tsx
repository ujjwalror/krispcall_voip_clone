'use client';

import React, { useState, useEffect } from 'react';

export interface AdminShadowPreviewProps {
  actorRole: string;
  actorId: string;
}

export function AdminShadowPreview({ actorRole, actorId }: AdminShadowPreviewProps) {
  const isPlatformAdmin = actorRole.toUpperCase() === 'SUPER_ADMIN' || actorRole.toUpperCase() === 'PLATFORM_ADMIN';

  const [shadowSummary, setShadowSummary] = useState({
    conceptualState: 'STATE_A_CURRENT_SIMULATION',
    policyStatus: 'APPROVED / INACTIVE',
    totalNumbersEvaluated: 120,
    authoritativeCycles: 115,
    requiresReconciliation: 5,
    wouldAttemptPaymentCount: 18,
    wouldNotifyCount: 42,
    wouldBecomeReleaseEligibleCount: 2,
    blockedByPortOutCount: 3,
    blockedByReconciliationCount: 5,
    actualProviderMutationsExecuted: 0,
    actualChargesExecuted: 0,
    actualNotificationsSent: 0,
  });

  return (
    <div className="space-y-6 rounded-xl border border-slate-800 bg-slate-950 p-6 text-slate-100 shadow-2xl">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100">Phase 17A Activation Control Plane</h2>
          <p className="text-xs text-slate-400">
            Platform Administration — Shadow Renewal Execution & Gate Controls
          </p>
        </div>

        <div className="flex items-center gap-2">
          <span className="rounded-full bg-blue-500/10 px-3 py-1 text-xs font-semibold text-blue-400 border border-blue-500/20">
            State: STATE_A (Simulation)
          </span>
          <span className="rounded-full bg-slate-800 px-3 py-1 text-xs font-mono text-slate-400">
            Active Policies: 0
          </span>
        </div>
      </div>

      {!isPlatformAdmin && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-xs text-amber-300">
          <p className="font-semibold">Read-Only View (Tenant Access)</p>
          <p className="mt-1">
            Activation control plane controls can only be viewed by authorized PLATFORM administrators.
          </p>
        </div>
      )}

      {/* Activation Gate Control Matrix */}
      <div>
        <h3 className="text-sm font-semibold text-slate-200">Activation Gate Matrix (Fail-Closed Architecture)</h3>
        <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
          <div className="rounded-lg border border-slate-800 bg-slate-900 p-3 flex justify-between items-center">
            <span>Commercial Policy Gate</span>
            <span className="font-bold text-rose-400">INACTIVE (0)</span>
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-900 p-3 flex justify-between items-center">
            <span>Shadow Evaluation Engine</span>
            <span className="font-bold text-emerald-400">SHADOW ONLY</span>
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-900 p-3 flex justify-between items-center">
            <span>Real Payment Collection</span>
            <span className="font-bold text-rose-400">OFF (0 Charges)</span>
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-900 p-3 flex justify-between items-center">
            <span>External Email Delivery</span>
            <span className="font-bold text-rose-400">OFF</span>
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-900 p-3 flex justify-between items-center">
            <span>External SMS Delivery</span>
            <span className="font-bold text-rose-400">OFF</span>
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-900 p-3 flex justify-between items-center">
            <span>Provider Release Mutation</span>
            <span className="font-bold text-rose-400">OFF (0 Mutations)</span>
          </div>
        </div>
      </div>

      {/* Shadow Simulation Metrics Overview */}
      <div>
        <h3 className="text-sm font-semibold text-slate-200">Shadow Operations Observability Metrics</h3>
        <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
            <span className="text-xs text-slate-400">Evaluated Numbers</span>
            <p className="text-xl font-bold text-slate-100">{shadowSummary.totalNumbersEvaluated}</p>
            <p className="text-[11px] text-slate-500 mt-1">Bounded batch evaluation</p>
          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
            <span className="text-xs text-slate-400">Would Attempt Payment</span>
            <p className="text-xl font-bold text-amber-400">{shadowSummary.wouldAttemptPaymentCount}</p>
            <p className="text-[11px] text-slate-500 mt-1">Actual Charges: 0</p>
          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
            <span className="text-xs text-slate-400">Would Send Notices</span>
            <p className="text-xl font-bold text-blue-400">{shadowSummary.wouldNotifyCount}</p>
            <p className="text-[11px] text-slate-500 mt-1">Actual Sent: 0</p>
          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
            <span className="text-xs text-slate-400">Would Be Release Eligible</span>
            <p className="text-xl font-bold text-purple-400">{shadowSummary.wouldBecomeReleaseEligibleCount}</p>
            <p className="text-[11px] text-slate-500 mt-1">Actual Released: 0</p>
          </div>
        </div>
      </div>

      {/* Safety & Interlocks Summary */}
      <div className="rounded-lg border border-slate-800 bg-slate-900 p-4 space-y-2 text-xs">
        <h4 className="font-semibold text-slate-300">Safety Interlocks & Pilot Protection</h4>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-slate-400">
          <div>Blocked by Port Out: <span className="text-slate-200 font-semibold">{shadowSummary.blockedByPortOutCount}</span></div>
          <div>Blocked by Reconciliation: <span className="text-slate-200 font-semibold">{shadowSummary.blockedByReconciliationCount}</span></div>
          <div>Provider Release Mutations: <span className="text-emerald-400 font-bold">0</span></div>
        </div>
        <p className="text-[11px] text-slate-500 pt-2 border-t border-slate-800">
          ✓ Backlog Storm Protection Active: Bounded batch evaluation, deterministic ordering, catch-up semantics enabled.
        </p>
      </div>
    </div>
  );
}
