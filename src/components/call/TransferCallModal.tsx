'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import {
  Users,
  PhoneForwarded,
  XCircle,
  Loader2,
  CheckCircle2,
  AlertCircle,
  User,
  Phone,
  Radio,
  ArrowRight,
} from 'lucide-react';

export interface EligibleTeamMember {
  id: string;
  fullName: string;
  email: string;
  role: string;
  active: boolean;
  availabilityStatus?: 'available' | 'busy' | 'offline';
}

export interface TransferCallModalProps {
  isOpen: boolean;
  onClose: () => void;
  callSid?: string;
  dbCallId?: string;
}

export function TransferCallModal({ isOpen, onClose, callSid, dbCallId }: TransferCallModalProps) {
  const [transferTab, setTransferTab] = useState<'internal' | 'external'>('internal');
  const [members, setMembers] = useState<EligibleTeamMember[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string>('');
  const [externalNumber, setExternalNumber] = useState<string>('');
  const [isLoadingMembers, setIsLoadingMembers] = useState<boolean>(true);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const fetchTeamMembers = useCallback(async () => {
    setIsLoadingMembers(true);
    setErrorMsg(null);
    try {
      const res = await fetch('/api/users/manage');
      if (res.ok) {
        const json = await res.json();
        const rawMembers = json.members || json.users || [];
        const mapped = rawMembers
          .filter((m: any) => m && m.active !== false)
          .map((m: any) => ({
            id: m.id,
            fullName: m.full_name || m.email || 'Team Member',
            email: m.email,
            role: m.role || 'member',
            active: true,
            availabilityStatus: m.availability_status || 'available',
          }));
        setMembers(mapped);
        if (mapped.length > 0) {
          setSelectedUserId(mapped[0].id);
        }
      }
    } catch (err) {
      console.error('[TransferCallModal] Error loading team members:', err);
      setErrorMsg('Failed to load eligible team members.');
    } finally {
      setIsLoadingMembers(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      fetchTeamMembers();
      setSuccessMsg(null);
      setErrorMsg(null);
    }
  }, [isOpen, fetchTeamMembers]);

  if (!isOpen) return null;

  const handleInternalTransfer = async () => {
    if (!selectedUserId) {
      setErrorMsg('Please select a team member to transfer the call to.');
      return;
    }

    setIsSubmitting(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      const res = await fetch('/api/twilio/calls/transfer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callSid,
          dbCallId,
          targetType: 'internal',
          targetUserId: selectedUserId,
          transferType: 'blind',
        }),
      });

      const json = await res.json();
      if (!res.ok || !json.result?.success) {
        throw new Error(json.message || json.error || 'Failed to transfer call.');
      }

      setSuccessMsg(json.result.message || 'Call transferred successfully.');
      setTimeout(() => {
        onClose();
      }, 1500);
    } catch (err: any) {
      console.error('[InternalTransfer Error]', err);
      setErrorMsg(err.message || 'Error transferring call.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleExternalTransfer = async () => {
    if (!externalNumber || !externalNumber.trim()) {
      setErrorMsg('Please enter a valid external phone number.');
      return;
    }

    setIsSubmitting(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      const res = await fetch('/api/twilio/calls/transfer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callSid,
          dbCallId,
          targetType: 'external',
          externalNumber: externalNumber.trim(),
          transferType: 'blind',
        }),
      });

      const json = await res.json();
      if (!res.ok || !json.result?.success) {
        throw new Error(json.message || json.error || 'Failed to transfer call to external number.');
      }

      setSuccessMsg(json.result.message || 'Call transferred successfully.');
      setTimeout(() => {
        onClose();
      }, 1500);
    } catch (err: any) {
      console.error('[ExternalTransfer Error]', err);
      setErrorMsg(err.message || 'Error transferring call to external number.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[10000] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-base font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
              <PhoneForwarded className="w-5 h-5 text-blue-600 dark:text-blue-400" />
              <span>Transfer Call</span>
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Transfer this active call to another team member or external phone number.
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1">
            <XCircle className="w-5 h-5" />
          </button>
        </div>

        {/* Banners */}
        {successMsg && (
          <div className="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/80 border border-emerald-200 text-emerald-800 text-xs flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>{successMsg}</span>
          </div>
        )}

        {errorMsg && (
          <div className="p-3 rounded-xl bg-rose-50 dark:bg-rose-950/80 border border-rose-200 text-rose-800 text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        {/* Tab Selection */}
        <div className="flex items-center gap-2 border-b border-slate-200 dark:border-slate-800 pb-3">
          <button
            onClick={() => setTransferTab('internal')}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 ${
              transferTab === 'internal'
                ? 'bg-blue-600 text-white'
                : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
            }`}
          >
            <Users className="w-3.5 h-3.5" />
            <span>Team Member</span>
          </button>

          <button
            onClick={() => setTransferTab('external')}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 ${
              transferTab === 'external'
                ? 'bg-blue-600 text-white'
                : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
            }`}
          >
            <Phone className="w-3.5 h-3.5" />
            <span>External Number</span>
          </button>
        </div>

        {/* Tab Content: Internal Team Member */}
        {transferTab === 'internal' && (
          <div className="space-y-4 text-xs">
            {isLoadingMembers ? (
              <div className="flex items-center justify-center py-8 text-slate-400 gap-2">
                <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
                <span>Loading team members...</span>
              </div>
            ) : members.length === 0 ? (
              <div className="p-6 text-center text-slate-500">
                No active team members available for transfer.
              </div>
            ) : (
              <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                <label className="font-bold text-slate-900 dark:text-slate-100 block">
                  Select Active Team Member
                </label>
                {members.map((m) => (
                  <div
                    key={m.id}
                    onClick={() => setSelectedUserId(m.id)}
                    className={`p-3 rounded-xl border cursor-pointer flex items-center justify-between transition-all ${
                      selectedUserId === m.id
                        ? 'border-blue-600 bg-blue-50/50 dark:bg-blue-950/40'
                        : 'border-slate-200 dark:border-slate-800 hover:border-slate-300'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-full bg-blue-100 dark:bg-blue-950 text-blue-600 dark:text-blue-400 flex items-center justify-center font-bold text-xs">
                        {m.fullName.substring(0, 2).toUpperCase()}
                      </div>
                      <div>
                        <h4 className="font-bold text-slate-900 dark:text-slate-100">{m.fullName}</h4>
                        <p className="text-[10px] text-slate-400 capitalize">{m.role}</p>
                      </div>
                    </div>

                    <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 capitalize">
                      {m.availabilityStatus || 'Available'}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
              <Button variant="outline" size="sm" onClick={onClose} className="text-xs">
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={handleInternalTransfer}
                disabled={isSubmitting || !selectedUserId}
                className="text-xs bg-blue-600 hover:bg-blue-500 font-bold"
              >
                {isSubmitting ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : null}
                <span>Transfer Call</span>
              </Button>
            </div>
          </div>
        )}

        {/* Tab Content: External PSTN Number */}
        {transferTab === 'external' && (
          <div className="space-y-4 text-xs">
            <div className="space-y-1.5">
              <label className="font-bold text-slate-900 dark:text-slate-100 block">
                Destination Phone Number (E.164)
              </label>
              <Input
                type="tel"
                value={externalNumber}
                onChange={(e) => setExternalNumber(e.target.value)}
                placeholder="e.g. +15550001234"
                className="font-mono text-xs"
              />
              <p className="text-[11px] text-slate-500">
                Rate &amp; wallet authorization verified server-side prior to creating external call leg.
              </p>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
              <Button variant="outline" size="sm" onClick={onClose} className="text-xs">
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={handleExternalTransfer}
                disabled={isSubmitting || !externalNumber.trim()}
                className="text-xs bg-blue-600 hover:bg-blue-500 font-bold"
              >
                {isSubmitting ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : null}
                <span>Transfer to Number</span>
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
