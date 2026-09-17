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
import { CRMSearchResult, CRMFieldMetadata } from '@/lib/integrations/crm/types';

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

  // Dynamic CRM Required Fields & Effective Mappings State
  const [dynamicFields, setDynamicFields] = useState<CRMFieldMetadata[]>([]);
  const [effectiveMappings, setEffectiveMappings] = useState<Record<string, string>>({});
  const [fieldMetadataMap, setFieldMetadataMap] = useState<Map<string, CRMFieldMetadata>>(new Map());
  const [customFieldValues, setCustomFieldValues] = useState<Record<string, any>>({});
  const [unsupportedRequiredField, setUnsupportedRequiredField] = useState<CRMFieldMetadata | null>(null);

  const [isLoading, setIsLoading] = useState(false);
  const [isInitializing, setIsInitializing] = useState(false);
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
      setCustomFieldValues({});
      setUnsupportedRequiredField(null);

      // Load CRM metadata & effective mappings
      loadCrmRequirements();
    }
  }, [isOpen, contact]);

  const loadCrmRequirements = async () => {
    setIsInitializing(true);
    try {
      // 1. Fetch metadata snapshot
      const fieldsRes = await fetch('/api/integrations/crm/fields?provider=zoho&module=Leads&refresh=false');
      const fieldsData = await fieldsRes.json();

      // 2. Fetch saved organization mappings
      const mapRes = await fetch('/api/integrations/crm/mapping?provider=zoho&module=Leads');
      const mapData = await mapRes.json();

      if (fieldsRes.ok && Array.isArray(fieldsData.fields)) {
        const allFields: CRMFieldMetadata[] = fieldsData.fields;
        const metaMap = new Map<string, CRMFieldMetadata>();
        allFields.forEach((f) => metaMap.set(f.fieldKey, f));
        setFieldMetadataMap(metaMap);

        const currentMappings: Record<string, string> = {};

        if (mapRes.ok && Array.isArray(mapData.mappings) && mapData.mappings.length > 0) {
          // A. Use saved org mappings
          for (const m of mapData.mappings) {
            if (m.localFieldKey && m.externalFieldKey) {
              currentMappings[m.localFieldKey] = m.externalFieldKey;
            }
          }
        } else {
          // B. If NO saved mappings, use in-memory adapter recommended defaults for display
          currentMappings.first_name = 'First_Name';
          currentMappings.last_name = 'Last_Name';
          currentMappings.phone = 'Phone';
          currentMappings.email = 'Email';
          currentMappings.company = 'Company';
          currentMappings.notes = 'Description';
        }

        setEffectiveMappings(currentMappings);

        const mappedKeys = new Set<string>(Object.values(currentMappings));

        // Identify required writable fields that are NOT mapped to local fields
        const unmappedRequired = allFields.filter(
          (f) => f.isRequired && f.isWritable && !mappedKeys.has(f.fieldKey)
        );

        // Check for unsupported complex required field
        const unsupported = unmappedRequired.find((f) => f.dataType === 'other');
        if (unsupported) {
          setUnsupportedRequiredField(unsupported);
        } else {
          setDynamicFields(unmappedRequired);
        }
      }
    } catch (err) {
      console.warn('[CreateZohoLeadModal] Error fetching CRM requirements:', err);
    } finally {
      setIsInitializing(false);
    }
  };

  const getMappingIndicator = (localKey: string) => {
    const extKey = effectiveMappings[localKey];
    if (!extKey) {
      return (
        <span className="text-[10px] text-slate-500 italic block mt-0.5">
          Not mapped — will not be sent to Zoho
        </span>
      );
    }
    const metadata = fieldMetadataMap.get(extKey);
    const label = metadata?.label || extKey;
    return (
      <span className="text-[10px] text-emerald-400/90 font-medium block mt-0.5 flex items-center gap-1">
        <span className="w-1 h-1 rounded-full bg-emerald-400"></span>
        Mapped to Zoho: <span className="font-semibold text-emerald-300">{label}</span>
      </span>
    );
  };

  const handleCustomFieldChange = (key: string, value: any) => {
    setCustomFieldValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async (skipDuplicateCheck = false) => {
    if (!contact) return;

    if (unsupportedRequiredField) {
      setError(`Your CRM requires '${unsupportedRequiredField.label}', which uses a field type not currently supported by VoIP Hub.`);
      return;
    }

    if (!lastName.trim() && !customFieldValues.Last_Name) {
      setError('Last Name is required to create a Zoho Lead.');
      return;
    }

    // Validate dynamic required inputs
    for (const reqField of dynamicFields) {
      const val = customFieldValues[reqField.fieldKey];
      if (val === undefined || val === null || String(val).trim() === '') {
        setError(`CRM required field '${reqField.label}' must be provided.`);
        return;
      }
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
          customFields: customFieldValues,
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

          {/* Unsupported Required Field Error Banner */}
          {unsupportedRequiredField && (
            <div className="p-4 rounded-xl bg-rose-950/80 border border-rose-800 text-rose-200 space-y-2">
              <div className="flex items-center gap-2 font-bold text-xs">
                <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                <span>Unsupported CRM Required Field</span>
              </div>
              <p className="text-xs text-rose-300/90 leading-relaxed">
                Your Zoho CRM layout requires field <span className="font-bold underline">{unsupportedRequiredField.label}</span> ({unsupportedRequiredField.fieldKey}), which uses a complex field type not currently supported by VoIP Hub.
              </p>
              <p className="text-[11px] text-slate-400">
                Please update your Zoho CRM page layout settings or complete this lead directly inside Zoho CRM.
              </p>
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
                  disabled={isLoading || Boolean(unsupportedRequiredField)}
                  className="w-full text-xs border-amber-700/60 text-amber-300 hover:bg-amber-950/60"
                >
                  Force Create New Lead Anyway
                </Button>
              </div>
            </div>
          )}

          {/* Initializing Spinner */}
          {isInitializing ? (
            <div className="py-8 text-center text-xs text-slate-400 flex flex-col items-center justify-center gap-2">
              <Loader2 className="w-5 h-5 animate-spin text-blue-400" />
              <span>Checking CRM layout requirements...</span>
            </div>
          ) : (
            /* Form Inputs */
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
                  {getMappingIndicator('first_name')}
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
                  {getMappingIndicator('last_name')}
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
                  {getMappingIndicator('phone')}
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
                  {getMappingIndicator('email')}
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
                {getMappingIndicator('company')}
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                  Notes & Remarks
                </label>
                <textarea
                  rows={2}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Created from VoIP Hub saved contact"
                  className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-200 text-xs focus:outline-none focus:border-blue-500"
                />
                {getMappingIndicator('notes')}
              </div>

              {/* Dynamic Customer-Specific Required CRM Fields */}
              {dynamicFields.length > 0 && (
                <div className="pt-2 border-t border-slate-800 space-y-3">
                  <p className="text-[11px] font-semibold text-amber-400 flex items-center gap-1.5">
                    <Badge variant="amber" size="sm">Required by your CRM</Badge>
                    <span>Additional CRM Required Fields</span>
                  </p>

                  {dynamicFields.map((field) => (
                    <div key={field.fieldKey} className="space-y-1">
                      <label className="text-[10px] font-semibold text-slate-300 uppercase tracking-wider flex items-center justify-between">
                        <span>{field.label} <span className="text-rose-400">*</span></span>
                        <span className="text-[9px] text-slate-500 font-mono">({field.dataType})</span>
                      </label>

                      {field.dataType === 'picklist' && field.options ? (
                        <select
                          value={customFieldValues[field.fieldKey] || ''}
                          onChange={(e) => handleCustomFieldChange(field.fieldKey, e.target.value)}
                          className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-200 text-xs focus:outline-none focus:border-blue-500"
                        >
                          <option value="">-- Select {field.label} --</option>
                          {field.options.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      ) : field.dataType === 'boolean' ? (
                        <select
                          value={customFieldValues[field.fieldKey] ?? ''}
                          onChange={(e) => handleCustomFieldChange(field.fieldKey, e.target.value === 'true')}
                          className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-200 text-xs focus:outline-none focus:border-blue-500"
                        >
                          <option value="">-- Select --</option>
                          <option value="true">Yes / True</option>
                          <option value="false">No / False</option>
                        </select>
                      ) : field.dataType === 'date' ? (
                        <input
                          type="date"
                          value={customFieldValues[field.fieldKey] || ''}
                          onChange={(e) => handleCustomFieldChange(field.fieldKey, e.target.value)}
                          className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-200 text-xs focus:outline-none focus:border-blue-500"
                        />
                      ) : (
                        <input
                          type={field.dataType === 'number' ? 'number' : 'text'}
                          value={customFieldValues[field.fieldKey] || ''}
                          onChange={(e) => handleCustomFieldChange(field.fieldKey, e.target.value)}
                          placeholder={`Enter ${field.label}`}
                          className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-200 text-xs focus:outline-none focus:border-blue-500"
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-800 flex items-center justify-end gap-2 bg-slate-950/40">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={isLoading}>
            Cancel
          </Button>
          <Button
            variant="success"
            size="sm"
            disabled={isLoading || isInitializing || !lastName.trim() || Boolean(unsupportedRequiredField)}
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

