'use client';

import React, { useState, useEffect } from 'react';

interface ReleaseNumberModalProps {
  isOpen: boolean;
  onClose: () => void;
  phoneNumberId: string;
  phoneNumberE164: string;
  onSuccess?: () => void;
}

export function ReleaseNumberModal({
  isOpen,
  onClose,
  phoneNumberId,
  phoneNumberE164,
  onSuccess,
}: ReleaseNumberModalProps) {
  const [typedConfirmation, setTypedConfirmation] = useState('');
  const [isCheckingEligibility, setIsCheckingEligibility] = useState(false);
  const [isEligible, setIsEligible] = useState(true);
  const [eligibilityBlockers, setEligibilityBlockers] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isSuccess, setIsSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && phoneNumberId) {
      setTypedConfirmation('');
      setStatusMessage(null);
      setError(null);
      setIsSuccess(false);
      checkEligibility();
    }
  }, [isOpen, phoneNumberId]);

  const checkEligibility = async () => {
    setIsCheckingEligibility(true);
    setError(null);
    try {
      const res = await fetch(`/api/phone-numbers/${phoneNumberId}/release`);
      const data = await res.json();
      if (res.ok) {
        setIsEligible(data.eligible);
        setEligibilityBlockers(data.blockers || []);
      } else {
        setError(data.error || 'Failed to check eligibility');
      }
    } catch (err: any) {
      setError('Network error while checking release eligibility');
    } finally {
      setIsCheckingEligibility(false);
    }
  };

  const handleReleaseSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (typedConfirmation.trim() !== phoneNumberE164.trim()) {
      setError(`Confirmation text must exactly match ${phoneNumberE164}`);
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setStatusMessage('Submitting release request...');

    try {
      const idempotencyKey = `rel_${phoneNumberId}_${Date.now()}`;
      const res = await fetch(`/api/phone-numbers/${phoneNumberId}/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirm_phone_number: typedConfirmation.trim(),
          idempotency_key: idempotencyKey,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Voluntary release failed');
        setStatusMessage(null);
        return;
      }

      if (data.status === 'released') {
        setIsSuccess(true);
        setStatusMessage('Number successfully released.');
        if (onSuccess) onSuccess();
      } else if (data.status === 'reconciliation_required') {
        setStatusMessage('Release request submitted. Provider confirmation is in progress.');
      } else {
        setStatusMessage(data.customerSafeStatus || 'Release request submitted.');
      }
    } catch (err: any) {
      setError('Network error submitting release request');
      setStatusMessage(null);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) return null;

  const isConfirmationMatched = typedConfirmation.trim() === phoneNumberE164.trim();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-xl shadow-2xl overflow-hidden text-slate-100">
        <div className="p-6 space-y-4">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <h3 className="text-lg font-semibold text-rose-500 flex items-center gap-2">
              <span>⚠️</span> Release Phone Number
            </h3>
            <button
              onClick={onClose}
              disabled={isSubmitting}
              className="text-slate-400 hover:text-slate-200 text-sm font-medium"
            >
              ✕
            </button>
          </div>

          {/* Warning Content */}
          <div className="text-sm text-slate-300 space-y-2 bg-slate-950 p-4 rounded-lg border border-rose-950">
            <p className="font-semibold text-rose-400">
              Warning: Releasing a number is permanent and destructive.
            </p>
            <p>
              Releasing <strong>{phoneNumberE164}</strong> removes it from your VoIP Hub account immediately upon provider confirmation. You may permanently lose access to this number.
            </p>
            <p className="text-xs text-amber-400 bg-amber-950/40 p-2 rounded border border-amber-900/50">
              💡 <strong>Release != Port-Out:</strong> If you want to keep this number and transfer it to another provider, do NOT release it. Use <strong>Port Out</strong> instead.
            </p>
          </div>

          {/* Eligibility Check Status */}
          {isCheckingEligibility && (
            <div className="text-sm text-slate-400 animate-pulse">
              Verifying release eligibility...
            </div>
          )}

          {!isCheckingEligibility && !isEligible && (
            <div className="p-3 bg-rose-950/50 border border-rose-800 rounded text-sm text-rose-300 space-y-1">
              <p className="font-semibold">Release Blocked:</p>
              <ul className="list-disc list-inside text-xs space-y-1">
                {eligibilityBlockers.map((b, idx) => (
                  <li key={idx}>{b}</li>
                ))}
              </ul>
            </div>
          )}

          {error && (
            <div className="p-3 bg-rose-900/40 border border-rose-700 text-rose-200 text-sm rounded">
              {error}
            </div>
          )}

          {statusMessage && (
            <div className="p-3 bg-blue-950/50 border border-blue-800 text-blue-200 text-sm rounded">
              {statusMessage}
            </div>
          )}

          {/* Confirmation Form */}
          {!isSuccess && isEligible && !isCheckingEligibility && (
            <form onSubmit={handleReleaseSubmit} className="space-y-4 pt-2">
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">
                  Type <strong className="text-slate-200 font-mono">{phoneNumberE164}</strong> to confirm:
                </label>
                <input
                  type="text"
                  value={typedConfirmation}
                  onChange={(e) => setTypedConfirmation(e.target.value)}
                  placeholder={phoneNumberE164}
                  disabled={isSubmitting}
                  className="w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-sm font-mono text-slate-100 focus:outline-none focus:border-rose-500"
                />
              </div>

              <div className="flex items-center justify-end gap-3 border-t border-slate-800 pt-4">
                <button
                  type="button"
                  onClick={onClose}
                  disabled={isSubmitting}
                  className="px-4 py-2 text-sm font-medium text-slate-300 hover:text-white transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!isConfirmationMatched || isSubmitting}
                  className="px-4 py-2 text-sm font-semibold text-white bg-rose-600 hover:bg-rose-500 disabled:opacity-40 disabled:cursor-not-allowed rounded transition-colors shadow-lg shadow-rose-950/50"
                >
                  {isSubmitting ? 'Releasing...' : 'Release Number'}
                </button>
              </div>
            </form>
          )}

          {isSuccess && (
            <div className="pt-2 text-right">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-white bg-slate-700 hover:bg-slate-600 rounded"
              >
                Close
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
