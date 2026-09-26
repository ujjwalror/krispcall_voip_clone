'use client';

import React, { useEffect, useState } from 'react';
import { CustomerWorkspaceVerificationStatus, WorkspaceVerificationType } from '@/lib/telephony/verification/types';

export default function WorkspaceVerificationSettingsPage() {
  const [statusData, setStatusData] = useState<CustomerWorkspaceVerificationStatus | null>(null);
  const [mockEnabled, setMockEnabled] = useState(false);
  const [verificationType, setVerificationType] = useState<WorkspaceVerificationType>('business');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const fetchStatus = async () => {
    try {
      setLoading(true);
      setErrorMsg(null);
      const res = await fetch('/api/workspace-verification');
      if (res.ok) {
        const json = await res.json();
        if (json.success) {
          setStatusData(json.data);
          setMockEnabled(!!json.mock_enabled);
          if (json.data.verification_type) {
            setVerificationType(json.data.verification_type);
          }
        } else {
          setErrorMsg(json.error || 'Failed to fetch status.');
        }
      } else {
        const json = await res.json().catch(() => ({}));
        setErrorMsg(json.error || 'Failed to fetch status.');
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Network error loading workspace verification.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  const handleStartVerification = async () => {
    try {
      setSubmitting(true);
      setErrorMsg(null);
      setSuccessMsg(null);

      const res = await fetch('/api/workspace-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'start',
          verification_type: verificationType,
        }),
      });

      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to start verification.');
      }

      setStatusData(json.data);
      setSuccessMsg('Workspace verification submitted and under review.');
    } catch (err: any) {
      setErrorMsg(err.message || 'Error starting workspace verification.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleMockComplete = async (targetStatus: 'verified' | 'rejected' | 'action_required') => {
    try {
      setSubmitting(true);
      setErrorMsg(null);
      setSuccessMsg(null);

      const res = await fetch('/api/workspace-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'mock_complete',
          target_status: targetStatus,
        }),
      });

      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to process mock verification update.');
      }

      setStatusData(json.data);
      setSuccessMsg(`Mock verification status set to: ${targetStatus.toUpperCase()}`);
    } catch (err: any) {
      setErrorMsg(err.message || 'Error executing mock verification update.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="p-8 max-w-4xl mx-auto space-y-6 animate-pulse">
        <div className="h-8 bg-slate-800 rounded w-1/3"></div>
        <div className="h-32 bg-slate-800/60 rounded-xl"></div>
      </div>
    );
  }

  const getStatusBadgeClass = (status: string) => {
    switch (status) {
      case 'verified':
        return 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30';
      case 'under_review':
        return 'bg-amber-500/20 text-amber-400 border-amber-500/30';
      case 'action_required':
      case 'rejected':
        return 'bg-rose-500/20 text-rose-400 border-rose-500/30';
      default:
        return 'bg-slate-500/20 text-slate-300 border-slate-500/30';
    }
  };

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-8 text-slate-100">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white tracking-tight">Account & Workspace Verification</h1>
        <p className="text-sm text-slate-400 mt-1">
          Manage platform identity trust for your workspace.
        </p>
      </div>

      {/* Explicit Domain Separation Notice */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 space-y-3">
        <div className="flex items-center space-x-2 text-blue-400">
          <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <h3 className="text-sm font-semibold">Verification Separation Notice</h3>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs text-slate-300">
          <div className="bg-slate-950/60 p-3.5 rounded-lg border border-slate-800/80">
            <div className="font-semibold text-slate-200 mb-1">A. Account / Workspace Verification</div>
            <p className="text-slate-400">
              Establishes platform anti-fraud trust and account identity confidence for your organization SaaS tenant.
            </p>
          </div>
          <div className="bg-slate-950/60 p-3.5 rounded-lg border border-slate-800/80">
            <div className="font-semibold text-slate-200 mb-1">B. Phone-Number Regulatory Compliance</div>
            <p className="text-slate-400">
              Governed independently per phone number by telecommunications regulation, country, number type, and vendor bundle requirements.
            </p>
          </div>
        </div>
      </div>

      {/* Messages */}
      {errorMsg && (
        <div className="p-4 bg-rose-500/10 border border-rose-500/20 rounded-xl text-rose-300 text-sm">
          {errorMsg}
        </div>
      )}
      {successMsg && (
        <div className="p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-emerald-300 text-sm">
          {successMsg}
        </div>
      )}

      {/* Main Verification Card */}
      {statusData && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-6 shadow-lg">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b border-slate-800">
            <div>
              <span className={`inline-block px-3 py-1 text-xs font-semibold rounded-full border uppercase tracking-wider ${getStatusBadgeClass(statusData.status)}`}>
                {statusData.status.replace('_', ' ')}
              </span>
              <h2 className="text-lg font-bold text-white mt-2">{statusData.headline}</h2>
              <p className="text-xs text-slate-300 mt-0.5">{statusData.description}</p>
            </div>
            {statusData.submitted_at && (
              <div className="text-xs text-slate-400 text-right">
                <div>Submitted: {new Date(statusData.submitted_at).toLocaleDateString()}</div>
                {statusData.verified_at && (
                  <div className="text-emerald-400 mt-0.5">Verified: {new Date(statusData.verified_at).toLocaleDateString()}</div>
                )}
              </div>
            )}
          </div>

          {/* Action Section for Owner/Admin */}
          {statusData.can_initiate ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Verification Type
                </label>
                <div className="grid grid-cols-2 gap-4 max-w-md">
                  <button
                    type="button"
                    onClick={() => setVerificationType('business')}
                    className={`p-3 rounded-lg border text-left text-xs transition-all ${
                      verificationType === 'business'
                        ? 'border-blue-500 bg-blue-500/10 text-white font-medium'
                        : 'border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <div className="font-semibold text-slate-200">Business</div>
                    <div className="text-[11px] text-slate-400 mt-0.5">Register as an organization / enterprise</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setVerificationType('individual')}
                    className={`p-3 rounded-lg border text-left text-xs transition-all ${
                      verificationType === 'individual'
                        ? 'border-blue-500 bg-blue-500/10 text-white font-medium'
                        : 'border-slate-800 bg-slate-950 text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <div className="font-semibold text-slate-200">Individual</div>
                    <div className="text-[11px] text-slate-400 mt-0.5">Register as a sole owner / individual</div>
                  </button>
                </div>
              </div>

              <div className="pt-2">
                <button
                  type="button"
                  onClick={handleStartVerification}
                  disabled={submitting}
                  className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-lg shadow transition-colors disabled:opacity-50"
                >
                  {submitting ? 'Submitting...' : 'Start Account Verification'}
                </button>
              </div>
            </div>
          ) : (
            <div className="text-xs text-slate-400 italic">
              {!['owner', 'admin'].includes((statusData as any).role || '') && statusData.status === 'not_started'
                ? 'Only Workspace Owners or Admins may initiate account verification.'
                : 'Workspace verification status is managed by platform identity evaluation.'}
            </div>
          )}

          {/* Development Mock Provider Safe Controls */}
          {mockEnabled && statusData.can_initiate && (
            <div className="mt-8 pt-6 border-t border-dashed border-amber-500/30 bg-amber-500/5 p-4 rounded-lg space-y-3">
              <div className="flex items-center space-x-2 text-amber-400">
                <span className="text-[10px] uppercase font-bold tracking-widest bg-amber-500/20 px-2 py-0.5 rounded">
                  Dev Mock Provider Active
                </span>
                <span className="text-xs text-slate-300">
                  WORKSPACE_VERIFICATION_MOCK_ENABLED=true
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Test state transitions safely in non-production environment:
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => handleMockComplete('verified')}
                  disabled={submitting}
                  className="px-3 py-1.5 bg-emerald-600/80 hover:bg-emerald-500 text-white text-xs font-medium rounded transition-colors"
                >
                  Simulate Verified
                </button>
                <button
                  type="button"
                  onClick={() => handleMockComplete('action_required')}
                  disabled={submitting}
                  className="px-3 py-1.5 bg-amber-600/80 hover:bg-amber-500 text-white text-xs font-medium rounded transition-colors"
                >
                  Simulate Action Required
                </button>
                <button
                  type="button"
                  onClick={() => handleMockComplete('rejected')}
                  disabled={submitting}
                  className="px-3 py-1.5 bg-rose-600/80 hover:bg-rose-500 text-white text-xs font-medium rounded transition-colors"
                >
                  Simulate Rejected
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
