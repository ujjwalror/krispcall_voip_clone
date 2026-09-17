'use client';

import React, { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import {
  X,
  Search,
  ExternalLink,
  Loader2,
  AlertCircle,
  Building,
  Mail,
  Phone,
  User,
  CheckCircle2,
} from 'lucide-react';
import { CRMSearchResult } from '@/lib/integrations/crm/types';

interface LinkCRMRecordModalProps {
  contactId: string;
  contactName: string;
  contactPhone: string;
  contactEmail?: string;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  onOpenCreateLead?: () => void;
}

export function LinkCRMRecordModal({
  contactId,
  contactName,
  contactPhone,
  contactEmail,
  isOpen,
  onClose,
  onSuccess,
  onOpenCreateLead,
}: LinkCRMRecordModalProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [isLinking, setIsLinking] = useState<string | null>(null);
  const [results, setResults] = useState<CRMSearchResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && contactId) {
      performSearch();
    }
  }, [isOpen, contactId]);

  const performSearch = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/integrations/crm/search?contactId=${contactId}&provider=zoho`);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to search Zoho CRM');
      }
      setResults(data.results || []);
    } catch (err: any) {
      setError(err.message || 'Error connecting to Zoho CRM');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSelectLink = async (candidate: CRMSearchResult) => {
    setIsLinking(candidate.externalRecordId);
    setError(null);
    try {
      const res = await fetch('/api/integrations/crm/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contactId,
          provider: 'zoho',
          externalModule: candidate.externalModule,
          externalRecordId: candidate.externalRecordId,
          externalDisplayName: candidate.displayName,
          externalEmail: candidate.email,
          externalPhone: candidate.phone,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to link record');
      }

      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to link candidate record');
    } finally {
      setIsLinking(null);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in">
      <div className="w-full max-w-xl rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="p-5 border-b border-slate-800 flex items-center justify-between bg-slate-950/40">
          <div>
            <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
              <Search className="w-4 h-4 text-blue-400" />
              <span>Link Existing Zoho CRM Record</span>
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Searching Zoho Leads & Contacts matching <span className="font-semibold text-slate-200">{contactName}</span> ({contactPhone})
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
        <div className="p-5 overflow-y-auto space-y-4 flex-1">
          {error && (
            <div className="p-3.5 rounded-xl bg-rose-950/70 border border-rose-800 text-rose-200 text-xs flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {isLoading ? (
            <div className="py-12 text-center text-xs text-slate-400 flex flex-col items-center justify-center gap-3">
              <Loader2 className="w-7 h-7 animate-spin text-blue-400" />
              <p className="font-medium">Searching Zoho CRM database...</p>
              <p className="text-[11px] text-slate-500">Checking Phone and Email against Zoho Leads and Contacts</p>
            </div>
          ) : results.length === 0 ? (
            <div className="py-10 text-center space-y-3">
              <div className="w-12 h-12 rounded-full bg-slate-800 text-slate-400 flex items-center justify-center mx-auto">
                <Search className="w-6 h-6" />
              </div>
              <p className="text-sm font-semibold text-slate-200">No matching Zoho CRM records found</p>
              <p className="text-xs text-slate-400 max-w-md mx-auto">
                No Zoho Lead or Contact matched phone number <span className="font-mono text-slate-300">{contactPhone}</span>
                {contactEmail ? ` or email ${contactEmail}` : ''}.
              </p>
              {onOpenCreateLead && (
                <div className="pt-2">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => {
                      onClose();
                      onOpenCreateLead();
                    }}
                  >
                    Create in Zoho CRM instead
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between text-xs text-slate-400 font-medium px-1">
                <span>Found {results.length} candidate match{results.length > 1 ? 'es' : ''} in Zoho:</span>
                <span className="text-[11px] text-slate-500">Select explicit match to link</span>
              </div>

              {results.map((candidate) => (
                <div
                  key={`${candidate.externalModule}:${candidate.externalRecordId}`}
                  className="p-4 rounded-xl bg-slate-950/60 border border-slate-800 hover:border-slate-700 transition-all flex items-start justify-between gap-4"
                >
                  <div className="space-y-1.5 flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge variant={candidate.externalModule === 'Leads' ? 'blue' : 'emerald'} size="sm">
                        Zoho {candidate.externalModule === 'Leads' ? 'Lead' : 'Contact'}
                      </Badge>
                      <h4 className="text-sm font-bold text-slate-100 truncate">{candidate.displayName}</h4>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-300">
                      {candidate.company && (
                        <p className="flex items-center gap-1.5 truncate text-slate-400">
                          <Building className="w-3.5 h-3.5 shrink-0 text-slate-500" />
                          <span className="truncate">{candidate.company}</span>
                        </p>
                      )}
                      {candidate.phone && (
                        <p className="flex items-center gap-1.5 font-mono text-slate-300">
                          <Phone className="w-3.5 h-3.5 shrink-0 text-slate-500" />
                          <span>{candidate.phone}</span>
                        </p>
                      )}
                      {candidate.email && (
                        <p className="flex items-center gap-1.5 truncate text-slate-400 sm:col-span-2">
                          <Mail className="w-3.5 h-3.5 shrink-0 text-slate-500" />
                          <span className="truncate">{candidate.email}</span>
                        </p>
                      )}
                      {candidate.ownerName && (
                        <p className="flex items-center gap-1.5 text-[11px] text-slate-500 sm:col-span-2">
                          <User className="w-3 h-3 shrink-0 text-slate-600" />
                          <span>Zoho Owner: {candidate.ownerName}</span>
                        </p>
                      )}
                    </div>
                  </div>

                  <Button
                    variant="primary"
                    size="sm"
                    disabled={isLinking !== null}
                    onClick={() => handleSelectLink(candidate)}
                    className="shrink-0"
                  >
                    {isLinking === candidate.externalRecordId ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <CheckCircle2 className="w-3.5 h-3.5" />
                    )}
                    <span>Select & Link</span>
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-800 flex items-center justify-between bg-slate-950/40">
          <Button variant="ghost" size="sm" onClick={performSearch} disabled={isLoading}>
            Refresh Search
          </Button>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
