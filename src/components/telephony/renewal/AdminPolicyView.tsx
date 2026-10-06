'use client';

import React, { useState } from 'react';
import { PreRenewalPolicyConfig } from '@/lib/telephony/renewal/types';
import { PreRenewalPolicyService } from '@/lib/telephony/renewal/preRenewalPolicyService';
import { PolicySimulationEngine } from '@/lib/telephony/renewal/policySimulationEngine';

export interface AdminPolicyViewProps {
  actorRole: string; // e.g. 'PLATFORM_ADMIN' or 'TENANT_OWNER'
  actorId: string;
  policyConfig?: PreRenewalPolicyConfig;
}

export function AdminPolicyView({
  actorRole,
  actorId,
  policyConfig = PreRenewalPolicyService.getApprovedPolicyV1(),
}: AdminPolicyViewProps) {
  const isPlatformAdmin = PreRenewalPolicyService.isPlatformAdmin(actorRole, actorId);
  const validation = PreRenewalPolicyService.validatePolicy(policyConfig);

  const [simDate, setSimDate] = useState<string>('2026-11-06T00:00:00.000Z');
  const [simAutopay, setSimAutopay] = useState<boolean>(false);
  const [simResult, setSimResult] = useState<any | null>(null);

  const handleRunSimulation = () => {
    const res = PolicySimulationEngine.simulateTimeline({
      phoneNumberE164: '+18005550199',
      cycleAnchorAt: simDate,
      customerFundedThroughAt: simDate,
      policy: policyConfig,
      autopayEnabled: simAutopay,
      providerCycleStatus: 'verified',
    });
    setSimResult(res);
  };

  return (
    <div className="space-y-6 rounded-xl border border-slate-800 bg-slate-950 p-6 text-slate-100 shadow-xl">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100">Commercial Renewal Policy Management</h2>
          <p className="text-xs text-slate-400">
            Platform Administration — Versioned Commercial Policy Engine
          </p>
        </div>

        <div className="flex items-center gap-2">
          <span className="rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-400 border border-emerald-500/20">
            Version {policyConfig.policyVersion} ({policyConfig.status || 'APPROVED'})
          </span>
          <span className="rounded-full bg-slate-800 px-3 py-1 text-xs font-mono text-slate-400">
            Production Active: OFF (Count: 0)
          </span>
        </div>
      </div>

      {!isPlatformAdmin && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-xs text-amber-300">
          <p className="font-semibold">Read-Only View (Tenant Level)</p>
          <p className="mt-1">
            Global commercial lifecycle policies can only be managed by authorized PLATFORM administrators.
            Tenant owners and admins cannot modify policy offsets or activation flags.
          </p>
        </div>
      )}

      {/* Policy Timing Offsets Grid */}
      <div>
        <h3 className="text-sm font-semibold text-slate-200">Policy Stage Timings (Relative to Exposure T0)</h3>
        <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
            <span className="text-xs text-slate-400">T-7 DAYS (Notice)</span>
            <p className="text-lg font-bold text-slate-100">{policyConfig.preRenewalNoticeLeadHours}h lead</p>
            <p className="text-[11px] text-slate-400 mt-1">Upcoming renewal notice sent to customer.</p>
          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
            <span className="text-xs text-slate-400">T-5 DAYS (Initial Action)</span>
            <p className="text-lg font-bold text-slate-100">{policyConfig.autopayAttemptLeadHours}h lead</p>
            <p className="text-[11px] text-slate-400 mt-1">Autopay attempt or payment-required warning.</p>
          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
            <span className="text-xs text-slate-400">T-3 DAYS (Retry / Reminder)</span>
            <p className="text-lg font-bold text-slate-100">{policyConfig.paymentRetryWindowHours}h lead</p>
            <p className="text-[11px] text-slate-400 mt-1">Payment retry attempt or renewal reminder.</p>
          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
            <span className="text-xs text-slate-400">T-2 DAYS (Strong Warning)</span>
            <p className="text-lg font-bold text-slate-100">{policyConfig.strongerWarningLeadHours}h lead</p>
            <p className="text-[11px] text-slate-400 mt-1">Stronger warning issued to customer.</p>
          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
            <span className="text-xs text-slate-400">T-1 DAY (Final Warning)</span>
            <p className="text-lg font-bold text-slate-100">{policyConfig.finalWarningLeadHours}h lead</p>
            <p className="text-[11px] text-slate-400 mt-1">Final critical number-loss warning.</p>
          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
            <span className="text-xs text-slate-400">T0 (Exposure Boundary)</span>
            <p className="text-lg font-bold text-slate-100">{policyConfig.releaseEligibilityBoundaryHours}h lead</p>
            <p className="text-[11px] text-slate-400 mt-1">Release eligibility evaluation (Safety Interlocks Active).</p>
          </div>
        </div>
      </div>

      {/* Validation Status */}
      <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
        <h4 className="text-xs font-semibold text-slate-300">Policy Validation Check</h4>
        {validation.valid ? (
          <p className="mt-1 text-xs text-emerald-400 font-semibold">
            ✓ Policy V1 Configuration Valid — Internal timing sequence and carrier safety interlocks passed.
          </p>
        ) : (
          <div className="mt-1 text-xs text-rose-400 space-y-1">
            <p className="font-semibold">✕ Policy Validation Errors:</p>
            <ul className="list-disc pl-5">
              {validation.errors.map((err, i) => (
                <li key={i}>{err}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Interactive Simulation Console */}
      <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
        <h4 className="text-sm font-semibold text-slate-200">Policy V1 Interactive Simulator</h4>
        <div className="mt-3 flex flex-wrap items-end gap-4 text-xs">
          <div>
            <label className="block text-slate-400 mb-1">Provider Exposure T0 (UTC ISO):</label>
            <input
              type="text"
              value={simDate}
              onChange={(e) => setSimDate(e.target.value)}
              className="rounded border border-slate-700 bg-slate-950 px-3 py-1.5 font-mono text-slate-200 w-64"
            />
          </div>

          <div>
            <label className="block text-slate-400 mb-1">Autopay Preference:</label>
            <select
              value={simAutopay ? 'true' : 'false'}
              onChange={(e) => setSimAutopay(e.target.value === 'true')}
              className="rounded border border-slate-700 bg-slate-950 px-3 py-1.5 text-slate-200"
            >
              <option value="false">Autopay Disabled</option>
              <option value="true">Autopay Enabled</option>
            </select>
          </div>

          <button
            onClick={handleRunSimulation}
            className="rounded bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500 transition-colors"
          >
            Run Timeline Simulation
          </button>
        </div>

        {simResult && (
          <div className="mt-4 rounded bg-slate-950 p-4 text-xs font-mono space-y-2 border border-slate-800">
            <p className="text-emerald-400 font-bold">Simulation Outcome: {simResult.finalOutcome}</p>
            <p className="text-slate-400">Release Eligible: {simResult.releaseEligible ? 'YES' : 'NO'}</p>
            <div className="space-y-1 pt-2">
              <p className="text-slate-300 font-semibold font-sans">Calculated Stage Timeline:</p>
              {simResult.timeline.map((st: any, idx: number) => (
                <div key={idx} className="flex justify-between border-b border-slate-900 pb-1 text-[11px]">
                  <span className="text-slate-300">{st.stage}</span>
                  <span className="text-amber-400">{st.timestamp || 'N/A'}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
