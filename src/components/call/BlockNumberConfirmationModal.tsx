'use client';

import React, { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Ban, AlertTriangle, Loader2 } from 'lucide-react';

interface BlockNumberConfirmationModalProps {
  phoneNumber: string | null;
  contactName?: string | null;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export function BlockNumberConfirmationModal({
  phoneNumber,
  contactName,
  isOpen,
  onClose,
  onSuccess,
}: BlockNumberConfirmationModalProps) {
  const [isBlocking, setIsBlocking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen || !phoneNumber) return null;

  const displayName = contactName ? `${contactName} (${phoneNumber})` : phoneNumber;

  const handleConfirmBlock = async () => {
    setIsBlocking(true);
    setError(null);
    try {
      const res = await fetch('/api/blocked-numbers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phoneNumber: phoneNumber,
          reason: 'Blocked from call history',
        }),
      });

      if (res.ok) {
        onSuccess();
        onClose();
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Failed to block number. Please try again.');
      }
    } catch (err) {
      console.error('Error blocking phone number:', err);
      setError('Network error blocking number.');
    } finally {
      setIsBlocking(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in">
      <div className="w-full max-w-md rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl p-6 space-y-5">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 shrink-0">
            <Ban className="w-6 h-6" />
          </div>
          <div>
            <h3 className="text-base font-bold text-slate-100">
              Block {displayName}?
            </h3>
            <p className="text-xs text-slate-400 font-mono mt-0.5">Organization Blocklist</p>
          </div>
        </div>

        {/* Warning Body */}
        <div className="p-3.5 rounded-xl bg-rose-100 dark:bg-rose-950/60 border border-rose-300 dark:border-rose-800/80 text-rose-900 dark:text-rose-200 text-xs space-y-1">
          <div className="flex items-center gap-1.5 font-semibold text-rose-800 dark:text-rose-300">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>Inbound & Outbound Block Protection</span>
          </div>
          <p className="text-slate-700 dark:text-slate-300 text-[11px] leading-relaxed pt-1">
            Future incoming calls from this number will not ring your team, and outgoing calls to this number will be prevented.
          </p>
        </div>

        {error && (
          <p className="text-xs text-rose-400 font-medium bg-rose-950/90 p-2.5 rounded-lg border border-rose-800">
            {error}
          </p>
        )}

        {/* Action Buttons */}
        <div className="flex items-center justify-end gap-3 pt-2 border-t border-slate-800">
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            disabled={isBlocking}
            className="text-slate-300 hover:bg-slate-800"
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={handleConfirmBlock}
            disabled={isBlocking}
            className="font-semibold shadow-lg shadow-rose-600/20"
          >
            {isBlocking ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Ban className="w-4 h-4" />
            )}
            <span>Block Number</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
