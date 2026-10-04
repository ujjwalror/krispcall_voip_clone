'use client';

import React, { useState, useEffect } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  Copy,
  HelpCircle,
  Info,
  ShieldAlert,
  X,
} from 'lucide-react';

export interface PortOutModalProps {
  isOpen: boolean;
  onClose: () => void;
  phoneNumberId: string;
  phoneNumberE164: string;
  formattedNumber?: string;
}

export function PortOutModal({
  isOpen,
  onClose,
  phoneNumberId,
  phoneNumberE164,
  formattedNumber,
}: PortOutModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [operation, setOperation] = useState<any | null>(null);
  const [instructions, setInstructions] = useState<any | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && phoneNumberId) {
      fetchStatus();
    }
  }, [isOpen, phoneNumberId]);

  const fetchStatus = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/phone-numbers/${phoneNumberId}/port-out`);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to fetch Port-Out status');
      }
      if (data.hasActivePortOut) {
        setOperation(data.operation);
        setInstructions(data.instructions);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleInitiatePortOut = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/phone-numbers/${phoneNumberId}/port-out`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to initiate Port-Out');
      }
      setOperation(data.operation);
      setInstructions(data.instructions);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = (text: string, fieldName: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(fieldName);
    setTimeout(() => setCopiedField(null), 2000);
  };

  if (!isOpen) return null;

  const displayPhone = formattedNumber || phoneNumberE164;
  const status = operation?.status || 'prepare';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="relative w-full max-w-2xl overflow-hidden rounded-2xl border border-slate-700 bg-slate-900/95 p-6 shadow-2xl text-slate-100">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 pb-4">
          <div className="flex items-center space-x-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
              <ArrowUpRight className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-xl font-bold tracking-tight text-white">
                Port Out Number ({displayPhone})
              </h2>
              <p className="text-xs text-slate-400">
                Transfer this phone number away from VoIP Hub to another carrier.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white transition"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Clear Explanation Banners */}
        <div className="mt-4 space-y-3">
          <div className="flex items-start space-x-3 rounded-xl border border-amber-500/20 bg-amber-500/10 p-3.5 text-amber-200">
            <ShieldAlert className="h-5 w-5 shrink-0 text-amber-400 mt-0.5" />
            <div className="text-xs space-y-1">
              <span className="font-semibold text-amber-300">Port-Out is NOT Number Release:</span>
              <p>
                Port-Out transfers ownership of this number to your new receiving carrier so you keep the number.
                Releasing the number is different and may cause you to permanently lose it.
              </p>
            </div>
          </div>

          <div className="flex items-start space-x-3 rounded-xl border border-blue-500/20 bg-blue-500/10 p-3.5 text-blue-200">
            <Info className="h-5 w-5 shrink-0 text-blue-400 mt-0.5" />
            <div className="text-xs space-y-1">
              <span className="font-semibold text-blue-300">Receiving Carrier Process:</span>
              <p>
                Start the transfer request directly with your new carrier. Keep this number active in VoIP Hub
                while transfer is underway. Do not delete your workspace or release the number.
              </p>
            </div>
          </div>
        </div>

        {error && (
          <div className="mt-4 flex items-center space-x-2 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-300">
            <AlertTriangle className="h-4 w-4 text-red-400 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Status Tracker Bar */}
        <div className="mt-5 rounded-xl border border-slate-800 bg-slate-950/60 p-4">
          <div className="text-xs font-medium text-slate-400 mb-2">Normalized Status Pipeline</div>
          <div className="flex items-center justify-between text-xs">
            <span className={`px-2.5 py-1 rounded-md font-medium ${status === 'prepare' ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30' : 'bg-slate-800 text-slate-400'}`}>
              Prepare
            </span>
            <span className={`px-2.5 py-1 rounded-md font-medium ${status === 'instructions_ready' ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : 'bg-slate-800 text-slate-400'}`}>
              Instructions Ready
            </span>
            <span className={`px-2.5 py-1 rounded-md font-medium ${status === 'port_out_pending' || status === 'carrier_processing' ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30' : 'bg-slate-800 text-slate-400'}`}>
              Carrier Processing
            </span>
            <span className={`px-2.5 py-1 rounded-md font-medium ${status === 'ported_out' ? 'bg-green-500/20 text-green-300 border border-green-500/30' : 'bg-slate-800 text-slate-400'}`}>
              Completed
            </span>
          </div>
        </div>

        {/* Body Content */}
        <div className="mt-5 space-y-4">
          {!operation ? (
            <div className="text-center py-6">
              <p className="text-sm text-slate-300 mb-4">
                Click below to prepare port-out authorization details for your receiving carrier.
              </p>
              <button
                onClick={handleInitiatePortOut}
                disabled={loading}
                className="rounded-xl bg-gradient-to-r from-indigo-500 to-blue-600 px-6 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-500/25 hover:from-indigo-600 hover:to-blue-700 transition disabled:opacity-50"
              >
                {loading ? 'Preparing Details...' : 'Prepare Port-Out Instructions'}
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-4">
                <div className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
                  Instruction Summary
                </div>
                <p className="text-sm text-slate-200">{instructions?.instructionSummary || operation.customerMessage}</p>

                {instructions?.notes && instructions.notes.length > 0 && (
                  <ul className="mt-3 space-y-1.5 border-t border-slate-800/80 pt-3 text-xs text-slate-400">
                    {instructions.notes.map((note: string, idx: number) => (
                      <li key={idx} className="flex items-start space-x-2">
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0 mt-0.5" />
                        <span>{note}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Authoritative Credentials (only if present; never fake) */}
              {instructions?.carrierAccountIdentifier && (
                <div className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950 p-3 text-xs">
                  <span className="text-slate-400">Carrier Account Identifier:</span>
                  <div className="flex items-center space-x-2">
                    <span className="font-mono text-white font-medium">{instructions.carrierAccountIdentifier}</span>
                    <button
                      onClick={() => handleCopy(instructions.carrierAccountIdentifier, 'acct')}
                      className="text-slate-400 hover:text-white"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                    {copiedField === 'acct' && <span className="text-[10px] text-emerald-400">Copied</span>}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="mt-6 flex items-center justify-between border-t border-slate-800 pt-4 text-xs text-slate-400">
          <span>VoIP Hub Porting Operations</span>
          <button
            onClick={onClose}
            className="rounded-lg bg-slate-800 px-4 py-2 font-medium text-slate-200 hover:bg-slate-700 transition"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
