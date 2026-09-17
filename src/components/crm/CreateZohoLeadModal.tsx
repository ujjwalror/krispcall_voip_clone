'use client';

import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import {
  X,
  UserPlus,
  AlertTriangle,
  Loader2,
  Building,
  Mail,
  Phone,
  User,
  CheckCircle2,
  ArrowRight,
} from 'lucide-react';
import { Contact } from '@/lib/types';
import { CRMSearchResult } from '@/lib/integrations/crm/types';

interface CreateZohoLeadModalProps {
  contact: Contact | null;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  onOpenLinkModal?: () => void;
}

export function CreateZohoLeadModal({
  contact,
  isOpen,
  onClose,
  onSuccess,
  onOpenLinkModal,
}: CreateZohoLeadModalProps) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [description, setDescription] = useState('Created from VoIP Hub saved contact');

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicateCandidates, setDuplicateCandidates] = useState<CRMSearchResult[]>([]);

  useEffect(() => {
    if (isOpen && contact) {
      setFirstName(contact.first_name || '');
      setLastName(contact.last_name || contact.full_name || '');
      setPhone(contact.phone || '');
      setEmail(contact.email || '');
      setCompany(contact.company || '');
      setDescription('Created from VoIP Hub saved contact');
      setError(null);
      setDuplicateCandidates([]);
    }
  }, [isOpen, contact]);

  const handleSubmit = async (skipDuplicateCheck = false) => {
    if (!contact) return;

    if (!lastName.trim()) {
      setError('Last Name is required to create a Zoho Lead.');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/integrations/crm/create-lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contactId: contact.id,
          provider: 'zoho',
          firstName: firstName.trim() || undefined,
          lastName: lastName.trim(),
          phone: phone.trim() || undefined,
          email: email.trim() || undefined,
          company: company.trim() || undefined,
          description: description.trim() || undefined,
          skipDuplicateCheck,
        }),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        if (data.duplicateCheckFailed && data.candidates) {
          setDuplicateCandidates(data.candidates);
          setError(data.message || 'Matching candidate records found in Zoho CRM.');
          return;
        }

        throw new Error(data.error || 'Failed to create Lead in Zoho CRM');
      }

      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Error creating Lead in Zoho CRM');
    } finally {
      setIsLoading(false);
    }
  };

  if (!isOpen || !contact) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in">
      <div className="w-full max-w-lg rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="p-5 border-b border-slate-800 flex items-center justify-between bg-slate-950/40">
          <div>
            <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
              <UserPlus className="w-4 h-4 text-emerald-400" />
              <span>Create Lead in Zoho CRM</span>
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Exports contact <span className="font-semibold text-slate-200">{contact.full_name}</span> to Zoho Leads module
            </p>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 overflow-y-auto space-y-4 flex-1 text-xs">
          {error && (
            <div className="p-3.5 rounded-xl bg-rose-950/70 border border-rose-800 text-rose-200 text-xs flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="font-semibold">{error}</p>
              </div>
            </div>
          )}

          {/* Duplicate Candidates Warning Banner */}
          {duplicateCandidates.length > 0 && (
            <div className="p-4 rounded-xl bg-amber-950/60 border border-amber-800 space-y-3">
              <div className="flex items-center gap-2 text-amber-300 font-semibold text-xs">
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                <span>Existing Zoho Records Match This Contact</span>
              </div>
              <p className="text-[11px] text-amber-200/80 leading-relaxed">
                Found {duplicateCandidates.length} candidate record(s) in Zoho matching phone/email. We recommend linking an existing record to avoid creating duplicates.
              </p>

              <div className="space-y-2 pt-1">
                {duplicateCandidates.map((candidate) => (
                  <div key={candidate.externalRecordId} className="p-2.5 rounded-lg bg-slate-950/80 border border-amber-900/50 flex items-center justify-between text-xs text-slate-200">
                    <div>
                      <span className="font-semibold">{candidate.displayName}</span>
                      <span className="text-[10px] text-slate-400 ml-2 font-mono">({candidate.externalModule})</span>
                    </div>
                    {candidate.phone && <span className="text-[11px] font-mono text-slate-400">{candidate.phone}</span>}
                  </div>
                ))}
              </div>

              <div className="flex items-center gap-2 pt-2">
                {onOpenLinkModal && (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => {
                      onClose();
                      onOpenLinkModal();
                    }}
                    className="w-full text-xs"
                  >
                    <ArrowRight className="w-3.5 h-3.5" />
                    <span>Switch to Link Existing Record</span>
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleSubmit(true)}
                  disabled={isLoading}
                  className="w-full text-xs border-amber-700/60 text-amber-300 hover:bg-amber-950/60"
                >
                  Force Create New Lead Anyway
                </Button>
              </div>
            </div>
          )}

          {/* Form */}
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                  First Name
                </label>
                <input
                  type="text"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  placeholder="First name"
                  className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-200 text-xs focus:outline-none focus:border-blue-500"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                  Last Name <span className="text-rose-400">*</span>
                </label>
                <input
                  type="text"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  placeholder="Last name (required)"
                  className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-200 text-xs focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                  Phone Number
                </label>
                <input
                  type="text"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+14155552671"
                  className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-200 text-xs font-mono focus:outline-none focus:border-blue-500"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                  Email Address
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="user@example.com"
                  className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-200 text-xs focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                Company / Organization
              </label>
              <input
                type="text"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                placeholder="Company Name (optional)"
                className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-200 text-xs focus:outline-none focus:border-blue-500"
              />
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                Description / Context Notes
              </label>
              <textarea
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Created from VoIP Hub saved contact"
                className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-200 text-xs focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-800 flex items-center justify-end gap-2 bg-slate-950/40">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={isLoading}>
            Cancel
          </Button>
          <Button
            variant="success"
            size="sm"
            disabled={isLoading || !lastName.trim()}
            onClick={() => handleSubmit(false)}
          >
            {isLoading ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <CheckCircle2 className="w-3.5 h-3.5" />
            )}
            <span>Confirm & Create Lead</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
