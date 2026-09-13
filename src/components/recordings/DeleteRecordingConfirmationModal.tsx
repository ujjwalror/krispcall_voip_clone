'use client';

import React, { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { X, Trash2, AlertTriangle, Loader2 } from 'lucide-react';
import { RecordingWithDetails } from '@/lib/repositories/recording.repository';

interface DeleteRecordingConfirmationModalProps {
  recording: RecordingWithDetails | null;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (deletedRecordingId: string) => void;
}

export function DeleteRecordingConfirmationModal({
  recording,
  isOpen,
  onClose,
  onSuccess,
}: DeleteRecordingConfirmationModalProps) {
  const [isDeleting, setIsDeleting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (!isOpen || !recording) return null;

  const targetNumber =
    recording.calls?.direction === 'outbound'
      ? recording.calls?.to_number || 'Unknown Destination'
      : recording.calls?.from_number || 'Unknown Caller';

  const handleDelete = async () => {
    setIsDeleting(true);
    setErrorMessage(null);

    try {
      const res = await fetch(`/api/recordings/${recording.id}`, {
        method: 'DELETE',
      });

      const data = await res.json();

      if (!res.ok) {
        setErrorMessage(data.error || 'Failed to delete call recording.');
        return;
      }

      onSuccess(recording.id);
      onClose();
    } catch (err: any) {
      console.error('Error deleting call recording:', err);
      setErrorMessage('Network error while deleting call recording.');
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="w-full max-w-md rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-5 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-rose-600/10 border border-rose-500/20 text-rose-400">
              <Trash2 className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-100">Delete recording?</h2>
              <p className="text-xs text-slate-400">Admin confirmation required.</p>
            </div>
          </div>

          <button
            onClick={onClose}
            disabled={isDeleting}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-3 text-xs">
          {errorMessage && (
            <div className="p-3 rounded-xl bg-rose-950/60 border border-rose-800 text-rose-200 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <span>{errorMessage}</span>
            </div>
          )}

          <p className="text-slate-200 font-medium leading-relaxed">
            This will permanently delete this call recording for <strong className="text-white font-mono">{targetNumber}</strong>.
          </p>

          <p className="text-rose-400 font-semibold text-xs">
            This action cannot be undone.
          </p>

          <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800 text-slate-400 leading-relaxed text-[11px]">
            <p className="font-semibold text-slate-300 mb-0.5">Call History Integrity:</p>
            <p>
              The audio recording file will be permanently removed from the telephony provider and database. The associated call log metadata (timestamps, duration, caller ID) will remain in Call History.
            </p>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="p-4 border-t border-slate-800 flex items-center justify-end gap-3 bg-slate-950/40">
          <Button variant="outline" size="md" onClick={onClose} disabled={isDeleting}>
            Cancel
          </Button>
          <Button variant="danger" size="md" onClick={handleDelete} disabled={isDeleting}>
            {isDeleting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Deleting...</span>
              </>
            ) : (
              <>
                <Trash2 className="w-4 h-4" />
                <span>Delete Recording</span>
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
