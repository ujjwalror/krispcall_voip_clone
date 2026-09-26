'use client';

import React, { useEffect, useState, useCallback, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import {
  ArrowLeft,
  ShieldCheck,
  Building2,
  User,
  FileText,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Info,
  Globe,
  Tag,
  Upload,
  Download,
  Lock,
  FileCheck,
} from 'lucide-react';
import { useAuth } from '@/components/providers/AuthProvider';

export interface EndUserFieldOption {
  label: string;
  value: string;
}

export interface EndUserFieldReq {
  fieldKey: string;
  groupKey?: string;
  friendlyName: string;
  required: boolean;
  description?: string;
  inputType?: 'text' | 'email' | 'tel' | 'url' | 'select' | 'radio' | 'date';
  options?: EndUserFieldOption[];
}

export interface SupportingDocumentAcceptedOpt {
  name: string;
  type: string;
  fields?: Array<{ machine_name: string; friendly_name: string }>;
}

export interface SupportingDocumentReq {
  requirementKey: string;
  name: string;
  description?: string;
  acceptedDocuments: SupportingDocumentAcceptedOpt[];
  fileEvidenceRequired: boolean;
}

export interface PreCheckData {
  status: string;
  regulationId: string | null;
  countryCode: string;
  numberType: string;
  endUserType: 'business' | 'individual';
  addressRequirement: string | null;
  endUserRequirements: EndUserFieldReq[];
  supportingDocumentRequirements: SupportingDocumentReq[];
  bundleRequired: boolean;
  message: string;
}

export interface ProfileDetails {
  id: string;
  organizationId: string;
  endUserType: 'business' | 'individual';
  countryCode: string;
  legalName: string;
  status: 'draft' | 'information_required' | 'ready_for_submission';
  snapshots: any[];
  fieldValues: Array<{
    requirementKey: string;
    fieldName: string;
    fieldValue: string;
    isEncrypted?: boolean;
  }>;
  documents?: Array<{
    id: string;
    requirementKey: string;
    documentType: string;
    originalFilename: string;
    mimeType: string;
    sizeBytes: number;
    status: string;
    storageObjectPath?: string;
  }>;
}

function renderSafeProviderText(text?: string | null): React.ReactNode {
  if (!text || !text.trim()) return null;

  const raw = text.trim();
  const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^\s\)]+)\)|(https?:\/\/[^\s\)]+)/g;

  const elements: React.ReactNode[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(raw)) !== null) {
    const matchStart = match.index;
    if (matchStart > lastIdx) {
      elements.push(raw.substring(lastIdx, matchStart));
    }

    if (match[1] && match[2]) {
      const label = match[1];
      const url = match[2];
      elements.push(
        <a
          key={`link_${matchStart}`}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 dark:text-blue-400 font-semibold underline hover:text-blue-700 dark:hover:text-blue-300 transition-colors"
        >
          {label}
        </a>
      );
    } else if (match[3]) {
      const url = match[3];
      elements.push(
        <a
          key={`raw_${matchStart}`}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 dark:text-blue-400 font-semibold underline hover:text-blue-700 dark:hover:text-blue-300 transition-colors break-all"
        >
          {url}
        </a>
      );
    }
    lastIdx = linkRegex.lastIndex;
  }

  if (lastIdx < raw.length) {
    elements.push(raw.substring(lastIdx));
  }

  return <>{elements}</>;
}

function isSyntheticProfile(legalName?: string): boolean {
  if (!legalName) return false;
  const lower = legalName.toLowerCase();
  return (
    lower.includes('synthetic') ||
    lower.includes('cardinality') ||
    lower.includes('test profile') ||
    lower.includes('mock corp') ||
    lower.includes('dummy corp')
  );
}

function VerificationContent() {
  const searchParams = useSearchParams();
  const { profile } = useAuth();
  const isOwnerOrAdmin = profile?.role === 'owner' || profile?.role === 'admin';

  const rawCountry = searchParams.get('country') || 'AU';
  const rawType = searchParams.get('type') || 'local';
  const rawEndUser = searchParams.get('endUserType') || 'business';
  const phoneNumber = searchParams.get('phoneNumber') || '';

  const countryCode = rawCountry.toUpperCase().trim();
  const numberType = ['local', 'mobile', 'toll_free'].includes(rawType) ? rawType : 'local';
  const endUserType = rawEndUser === 'individual' ? 'individual' : 'business';

  // Wizard Step Control (1: Registration, 2: Info, 3: Documents, 4: Review)
  const [activeStep, setActiveStep] = useState<number>(1);

  // Requirements & Profile State
  const [isLoadingRequirements, setIsLoadingRequirements] = useState<boolean>(true);
  const [preCheck, setPreCheck] = useState<PreCheckData | null>(null);
  const [reqError, setReqError] = useState<string | null>(null);

  // Active Compliance Profile State
  const [availableProfiles, setAvailableProfiles] = useState<ProfileDetails[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string>('new');
  const [activeProfile, setActiveProfile] = useState<ProfileDetails | null>(null);
  const [legalNameInput, setLegalNameInput] = useState<string>('');
  const [isCreatingProfile, setIsCreatingProfile] = useState<boolean>(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  // Dynamic Form Field State
  const [fieldInputs, setFieldInputs] = useState<Record<string, string>>({});
  const [isSavingFields, setIsSavingFields] = useState<boolean>(false);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);

  // Document Upload State
  const [uploadingKey, setUploadingKey] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Submission & Status State
  const [isSubmittingProfile, setIsSubmittingProfile] = useState<boolean>(false);
  const [submissionResult, setSubmissionResult] = useState<any | null>(null);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [isSyncingStatus, setIsSyncingStatus] = useState<boolean>(false);

  // 1. Fetch Dynamic Provider Requirements via Regulatory Pre-Check API
  const fetchRequirements = useCallback(async () => {
    setIsLoadingRequirements(true);
    setReqError(null);
    try {
      const res = await fetch(
        `/api/number-marketplace/regulatory-precheck?countryCode=${countryCode}&numberType=${numberType}&endUserType=${endUserType}`
      );
      const json = await res.json();
      if (res.ok && json.success && json.preCheck) {
        setPreCheck(json.preCheck);
      } else {
        setReqError(json.error || 'Failed to fetch dynamic verification requirements.');
      }
    } catch (err) {
      console.error('[VerificationPage] Error fetching requirements:', err);
      setReqError('Network error fetching verification requirements.');
    } finally {
      setIsLoadingRequirements(false);
    }
  }, [countryCode, numberType, endUserType]);

  // 2. Fetch Existing Compliance Profiles for Organization
  const fetchProfiles = useCallback(async () => {
    if (!isOwnerOrAdmin) return;
    try {
      const res = await fetch('/api/compliance/profiles');
      if (res.ok) {
        const json = await res.json();
        const existing = (json.profiles || []).filter(
          (p: ProfileDetails) =>
            p.countryCode === countryCode &&
            p.endUserType === endUserType &&
            !isSyntheticProfile(p.legalName)
        );
        setAvailableProfiles(existing);
        if (existing.length > 0) {
          setSelectedProfileId(existing[0].id);
        } else {
          setSelectedProfileId('new');
        }
      }
    } catch (err) {
      console.error('[VerificationPage] Error fetching profiles:', err);
    }
  }, [countryCode, endUserType, isOwnerOrAdmin]);

  useEffect(() => {
    fetchRequirements();
    fetchProfiles();
  }, [fetchRequirements, fetchProfiles]);

  const handleConfirmSelectedProfile = (profileId: string) => {
    const target = availableProfiles.find((p) => p.id === profileId);
    if (target) {
      setActiveProfile(target);
      setLegalNameInput(target.legalName);
      const inputsMap: Record<string, string> = {};
      (target.fieldValues || []).forEach((fv: any) => {
        inputsMap[`${fv.requirementKey}__${fv.fieldName}`] = fv.fieldValue;
      });
      setFieldInputs(inputsMap);
      setActiveStep(2);
    }
  };

  // 3. Create Draft Profile
  const handleCreateProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!legalNameInput.trim()) {
      setProfileError('Legal business or individual name is required.');
      return;
    }

    setIsCreatingProfile(true);
    setProfileError(null);

    try {
      const res = await fetch('/api/compliance/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          countryCode,
          numberType,
          endUserType,
          legalName: legalNameInput.trim(),
        }),
      });

      const json = await res.json();
      if (res.ok && json.success && json.profile) {
        setActiveProfile(json.profile);
        setActiveStep(2); // Progress to info step
      } else {
        setProfileError(json.error || 'Failed to create compliance profile.');
      }
    } catch (err) {
      console.error('[VerificationPage] Error creating profile:', err);
      setProfileError('Network error creating compliance profile.');
    } finally {
      setIsCreatingProfile(false);
    }
  };

  // 4. Save Dynamic Field Values
  const handleSaveFields = async () => {
    if (!activeProfile) return;
    setIsSavingFields(true);
    setSaveSuccess(null);
    setProfileError(null);

    try {
      const fieldValuesArray: Array<{ requirementKey: string; fieldName: string; fieldValue: string }> = [];

      Object.entries(fieldInputs).forEach(([compositeKey, val]) => {
        const [reqKey, fieldName] = compositeKey.split('__');
        if (reqKey && fieldName && val.trim()) {
          fieldValuesArray.push({
            requirementKey: reqKey,
            fieldName,
            fieldValue: val.trim(),
          });
        }
      });

      const res = await fetch(`/api/compliance/profiles/${activeProfile.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fieldValues: fieldValuesArray }),
      });

      const json = await res.json();
      if (res.ok && json.success && json.profile) {
        setActiveProfile(json.profile);
        setSaveSuccess('Information saved securely with AES-256 encryption.');
        setActiveStep(3); // Progress to documents step
      } else {
        setProfileError(json.error || 'Failed to save compliance information.');
      }
    } catch (err) {
      console.error('[VerificationPage] Error saving fields:', err);
      setProfileError('Network error saving compliance information.');
    } finally {
      setIsSavingFields(false);
    }
  };

  // Helper for customer-friendly status formatting
  const formatCustomerStatus = (status: string): string => {
    const norm = (status || '').toLowerCase().replace(/_/g, ' ');
    if (norm === 'draft') return 'Draft';
    if (norm === 'information required') return 'Information required';
    if (norm === 'ready for submission') return 'Ready to submit';
    if (norm === 'pending review' || norm === 'pending-review') return 'Under review';
    if (norm === 'action required' || norm === 'rejected') return 'Action required';
    if (norm === 'approved') return 'Approved';
    return norm.charAt(0).toUpperCase() + norm.slice(1);
  };

  // 5. Handle Document Upload with Immediate Active Profile Reconciliation
  const handleFileUpload = async (requirementKey: string, documentType: string, file: File) => {
    if (!activeProfile) return;
    setUploadingKey(requirementKey);
    setUploadError(null);

    if (file.size > 5 * 1024 * 1024) {
      setUploadError('File size exceeds maximum 5MB limit.');
      setUploadingKey(null);
      return;
    }

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('complianceProfileId', activeProfile.id);
      formData.append('requirementKey', requirementKey);
      formData.append('documentType', documentType);

      const res = await fetch('/api/compliance/documents', {
        method: 'POST',
        body: formData,
      });

      const json = await res.json();
      if (res.ok && json.success && json.document) {
        // Refetch active profile details directly for immediate UI reconciliation
        const profileRes = await fetch(`/api/compliance/profiles/${activeProfile.id}`);
        if (profileRes.ok) {
          const profileJson = await profileRes.json();
          if (profileJson.profile) {
            setActiveProfile(profileJson.profile);
          }
        }
        fetchProfiles();
      } else {
        setUploadError(json.error || 'Failed to upload document.');
      }
    } catch (err) {
      console.error('[VerificationPage] Error uploading document:', err);
      setUploadError('Network error uploading document.');
    } finally {
      setUploadingKey(null);
    }
  };

  // 6. Handle Secure Document Download
  const handleDownloadDocument = async (documentId: string, filename: string) => {
    try {
      const res = await fetch(`/api/compliance/documents/${documentId}/download`);
      const json = await res.json();
      if (res.ok && json.success && json.signedUrl) {
        window.open(json.signedUrl, '_blank');
      } else {
        alert(json.error || 'Failed to generate download link.');
      }
    } catch (err) {
      console.error('Download error:', err);
      alert('Network error downloading document.');
    }
  };

  // 7. Handle Provider Verification Submission
  const handleStartSubmission = async () => {
    if (!activeProfile) return;
    setIsSubmittingProfile(true);
    setSubmissionError(null);
    setSubmissionResult(null);

    try {
      const res = await fetch(`/api/compliance/profiles/${activeProfile.id}/submit`, {
        method: 'POST',
      });
      const json = await res.json();
      if (res.ok && json.success) {
        setSubmissionResult(json);
        fetchProfiles();
      } else {
        setSubmissionError(json.message || json.error || 'Failed to submit verification profile.');
      }
    } catch (err) {
      console.error('[VerificationPage] Error submitting profile:', err);
      setSubmissionError('Network error submitting compliance profile.');
    } finally {
      setIsSubmittingProfile(false);
    }
  };

  // 8. Handle Status Polling Sync
  const handleSyncStatus = async () => {
    if (!activeProfile) return;
    setIsSyncingStatus(true);
    try {
      const res = await fetch(`/api/compliance/profiles/${activeProfile.id}/sync`, {
        method: 'POST',
      });
      const json = await res.json();
      if (res.ok && json.success) {
        fetchProfiles();
      }
    } catch (err) {
      console.error('[VerificationPage] Error syncing status:', err);
    } finally {
      setIsSyncingStatus(false);
    }
  };

  if (!isOwnerOrAdmin) {
    return (
      <Card className="p-8 max-w-lg mx-auto text-center space-y-4 border-rose-200 bg-rose-50/50">
        <AlertTriangle className="w-8 h-8 text-rose-600 mx-auto" />
        <h3 className="text-base font-bold text-rose-900">Access Restricted</h3>
        <p className="text-xs text-rose-700">
          Compliance profile management requires Owner or Admin workspace role access.
        </p>
        <Link href="/numbers/marketplace">
          <Button variant="outline" className="text-xs mt-2">
            Back to Marketplace
          </Button>
        </Link>
      </Card>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl mx-auto pb-16">
      {/* Top Navigation */}
      <div className="flex items-center justify-between">
        <Link
          href="/numbers/marketplace"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to Marketplace</span>
        </Link>
      </div>

      {/* Clean Customer-Facing Header Banner */}
      <div className="border-b border-slate-200 dark:border-slate-800 pb-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-6 h-6 text-blue-600 dark:text-blue-400" />
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">
            Number Verification
          </h1>
          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-300">
            Secure KYC Setup
          </span>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
          Complete regulatory requirements and submit documents to prepare your number for activation.
        </p>
      </div>

      {/* Number Selection Summary Card */}
      <Card className="p-4 bg-slate-50 dark:bg-slate-900/60 border-slate-200 dark:border-slate-800">
        <div className="flex flex-wrap items-center justify-between gap-4 text-xs">
          <div>
            <span className="text-[11px] font-semibold text-slate-500 block uppercase">Selected Number</span>
            <span className="text-sm font-bold text-slate-900 dark:text-slate-100">
              {phoneNumber || `${countryCode} ${numberType.replace('_', ' ').toUpperCase()}`}
            </span>
          </div>

          <div className="flex items-center gap-4 text-slate-600 dark:text-slate-400">
            <span className="flex items-center gap-1">
              <Globe className="w-3.5 h-3.5 text-slate-400" /> Country: <strong className="text-slate-900 dark:text-slate-100">{countryCode}</strong>
            </span>
            <span className="flex items-center gap-1">
              <Tag className="w-3.5 h-3.5 text-slate-400" /> Category: <strong className="text-slate-900 dark:text-slate-100 capitalize">{numberType}</strong>
            </span>
            <span className="flex items-center gap-1">
              {endUserType === 'business' ? <Building2 className="w-3.5 h-3.5 text-slate-400" /> : <User className="w-3.5 h-3.5 text-slate-400" />}
              Registration: <strong className="text-slate-900 dark:text-slate-100 capitalize">{endUserType}</strong>
            </span>
          </div>
        </div>
      </Card>

      {/* NO-ADDITIONAL-VERIFICATION BYPASS PATH */}
      {preCheck && preCheck.status === 'no_additional_requirements' && !preCheck.bundleRequired ? (
        <Card className="p-8 text-center space-y-4 bg-emerald-50/50 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800">
          <CheckCircle2 className="w-10 h-10 text-emerald-600 mx-auto" />
          <div className="space-y-1">
            <h3 className="text-base font-bold text-emerald-950 dark:text-emerald-100">
              No Additional Verification Required
            </h3>
            <p className="text-xs text-emerald-700 dark:text-emerald-300 max-w-md mx-auto leading-relaxed">
              This number category for {countryCode} does not require additional regulatory compliance documentation before purchase.
            </p>
          </div>
          <div className="pt-2">
            <Link href="/numbers/marketplace">
              <Button className="text-xs bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 font-semibold">
                Return to Marketplace
              </Button>
            </Link>
          </div>
        </Card>
      ) : preCheck && (preCheck.status === 'unavailable' || preCheck.status === 'error') ? (
        /* REGULATORY-UNKNOWN FAIL-CLOSED PATH */
        <Card className="p-8 text-center space-y-4 bg-rose-50/50 dark:bg-rose-950/20 border-rose-200 dark:border-rose-900">
          <AlertTriangle className="w-10 h-10 text-rose-600 mx-auto" />
          <div className="space-y-1">
            <h3 className="text-base font-bold text-rose-950 dark:text-rose-100">
              Regulatory Status Unavailable
            </h3>
            <p className="text-xs text-rose-700 dark:text-rose-300 max-w-md mx-auto leading-relaxed">
              Unable to verify regulatory requirements for this line category. Purchase progression is currently blocked.
            </p>
          </div>
          <div className="pt-2">
            <Link href="/numbers/marketplace">
              <Button variant="outline" className="text-xs">
                Return to Marketplace
              </Button>
            </Link>
          </div>
        </Card>
      ) : (
        <>
          {/* 4-STEP WIZARD PROGRESS HEADER */}
      <div className="grid grid-cols-4 gap-2 text-center text-xs font-semibold">
        <button
          onClick={() => setActiveStep(1)}
          className={`p-2.5 rounded-lg border transition-all ${
            activeStep === 1
              ? 'bg-blue-600 text-white border-blue-600'
              : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-800'
          }`}
        >
          1. Registration
        </button>
        <button
          onClick={() => activeProfile && setActiveStep(2)}
          disabled={!activeProfile}
          className={`p-2.5 rounded-lg border transition-all ${
            activeStep === 2
              ? 'bg-blue-600 text-white border-blue-600'
              : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-800 disabled:opacity-50'
          }`}
        >
          2. Required Info
        </button>
        <button
          onClick={() => activeProfile && setActiveStep(3)}
          disabled={!activeProfile}
          className={`p-2.5 rounded-lg border transition-all ${
            activeStep === 3
              ? 'bg-blue-600 text-white border-blue-600'
              : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-800 disabled:opacity-50'
          }`}
        >
          3. Documents
        </button>
        <button
          onClick={() => activeProfile && setActiveStep(4)}
          disabled={!activeProfile}
          className={`p-2.5 rounded-lg border transition-all ${
            activeStep === 4
              ? 'bg-blue-600 text-white border-blue-600'
              : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-800 disabled:opacity-50'
          }`}
        >
          4. Review
        </button>
      </div>

      {/* STEP 1: REGISTRATION DETAILS */}
      {activeStep === 1 && (
        <Card className="p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
            <span className="text-xs font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
              {endUserType === 'business' ? <Building2 className="w-4 h-4 text-blue-500" /> : <User className="w-4 h-4 text-blue-500" />}
              <span>Step 1: Legal Profile Setup</span>
            </span>
            {activeProfile && (
              <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
                Status: {activeProfile.status}
              </span>
            )}
          </div>

          {!activeProfile ? (
            <div className="space-y-4">
              <p className="text-xs text-slate-600 dark:text-slate-400">
                Please select or confirm the official legal entity or individual name that will be registered for provider compliance.
              </p>

              {availableProfiles.length > 0 ? (
                <div className="space-y-3">
                  <label className="text-xs font-semibold text-slate-800 dark:text-slate-200 block">
                    {endUserType === 'business' ? 'Existing Organization Profiles' : 'Existing Individual Profiles'}
                  </label>
                  <div className="space-y-2">
                    {availableProfiles.map((p) => (
                      <label
                        key={p.id}
                        className={`p-3 rounded-xl border cursor-pointer transition-all flex items-center justify-between ${
                          selectedProfileId === p.id
                            ? 'bg-blue-50/70 dark:bg-blue-950/40 border-blue-500 ring-1 ring-blue-500'
                            : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 hover:border-slate-300'
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <input
                            type="radio"
                            name="profileSelection"
                            value={p.id}
                            checked={selectedProfileId === p.id}
                            onChange={() => setSelectedProfileId(p.id)}
                            className="w-4 h-4 text-blue-600 focus:ring-blue-500"
                          />
                          <div>
                            <span className="text-xs font-bold text-slate-900 dark:text-slate-100 block">
                              {p.legalName}
                            </span>
                            <span className="text-[10px] text-slate-500">
                              Profile ID: <code className="font-mono">{p.id.slice(0, 8)}...</code> • Status: {(p.status as string).replace(/_/g, ' ')}
                            </span>
                          </div>
                        </div>
                        <span className="text-[10px] font-semibold text-blue-600 dark:text-blue-400 bg-blue-100 dark:bg-blue-950 px-2 py-0.5 rounded border border-blue-200 dark:border-blue-800">
                          Existing Profile
                        </span>
                      </label>
                    ))}

                    <label
                      className={`p-3 rounded-xl border cursor-pointer transition-all flex items-center gap-3 ${
                        selectedProfileId === 'new'
                          ? 'bg-blue-50/70 dark:bg-blue-950/40 border-blue-500 ring-1 ring-blue-500'
                          : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 hover:border-slate-300'
                      }`}
                    >
                      <input
                        type="radio"
                        name="profileSelection"
                        value="new"
                        checked={selectedProfileId === 'new'}
                        onChange={() => setSelectedProfileId('new')}
                        className="w-4 h-4 text-blue-600 focus:ring-blue-500"
                      />
                      <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                        + Register a new legal {endUserType === 'business' ? 'business entity' : 'individual profile'}
                      </span>
                    </label>
                  </div>

                  {selectedProfileId !== 'new' ? (
                    <div className="pt-2">
                      <Button
                        type="button"
                        onClick={() => handleConfirmSelectedProfile(selectedProfileId)}
                        className="text-xs px-4 h-9 bg-blue-600 hover:bg-blue-700 text-white font-semibold flex items-center gap-2"
                      >
                        <span>Confirm & Use Selected Profile &rarr;</span>
                      </Button>
                    </div>
                  ) : (
                    <form onSubmit={handleCreateProfile} className="space-y-3 pt-2">
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-slate-700 dark:text-slate-300 block">
                          {endUserType === 'business' ? 'New Legal Business Name' : 'Full Legal Individual Name'}
                        </label>
                        <input
                          type="text"
                          placeholder={endUserType === 'business' ? 'e.g. Acme Telecom Pty Ltd' : 'e.g. Jane Doe'}
                          value={legalNameInput}
                          onChange={(e) => setLegalNameInput(e.target.value)}
                          className="w-full h-9 px-3 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>

                      {profileError && (
                        <div className="p-2.5 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-xs text-rose-700 dark:text-rose-300">
                          {profileError}
                        </div>
                      )}

                      <Button
                        type="submit"
                        disabled={isCreatingProfile || !legalNameInput.trim()}
                        className="text-xs px-4 h-9 bg-blue-600 hover:bg-blue-700 text-white font-semibold flex items-center gap-2"
                      >
                        {isCreatingProfile ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                        <span>Create & Confirm New Profile &rarr;</span>
                      </Button>
                    </form>
                  )}
                </div>
              ) : (
                <form onSubmit={handleCreateProfile} className="space-y-4">
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-slate-700 dark:text-slate-300 block">
                      {endUserType === 'business' ? 'Legal Business Name' : 'Full Legal Individual Name'}
                    </label>
                    <input
                      type="text"
                      placeholder={endUserType === 'business' ? 'e.g. Acme Telecom Pty Ltd' : 'e.g. Jane Doe'}
                      value={legalNameInput}
                      onChange={(e) => setLegalNameInput(e.target.value)}
                      className="w-full h-9 px-3 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>

                  {profileError && (
                    <div className="p-2.5 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-xs text-rose-700 dark:text-rose-300">
                      {profileError}
                    </div>
                  )}

                  <Button
                    type="submit"
                    disabled={isCreatingProfile || !legalNameInput.trim()}
                    className="text-xs px-4 h-9 bg-blue-600 hover:bg-blue-700 text-white font-semibold flex items-center gap-2"
                  >
                    {isCreatingProfile ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                    <span>Create & Confirm Legal Profile &rarr;</span>
                  </Button>
                </form>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 flex items-center justify-between">
                <div>
                  <span className="text-[10px] font-bold text-slate-400 block uppercase">CONFIRMED LEGAL NAME</span>
                  <span className="text-sm font-bold text-slate-900 dark:text-slate-100">
                    {activeProfile.legalName}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-500">
                    Profile ID: <code className="font-mono text-[11px]">{activeProfile.id.slice(0, 8)}...</code>
                  </span>
                  <Button
                    variant="outline"
                    onClick={() => setActiveProfile(null)}
                    className="text-[11px] h-7 px-2.5"
                  >
                    Change Selection
                  </Button>
                </div>
              </div>

              <div className="flex justify-end pt-2">
                <Button onClick={() => setActiveStep(2)} className="text-xs bg-blue-600 hover:bg-blue-700 text-white font-semibold">
                  Next: Required Info &rarr;
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}

      {/* STEP 2: REQUIRED INFORMATION (DYNAMIC FORM WITH AES-256 ENCRYPTION) */}
      {activeStep === 2 && activeProfile && (
        <Card className="p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
            <span className="text-xs font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
              <FileText className="w-4 h-4 text-blue-500" />
              <span>Step 2: Required Information</span>
            </span>
            <span className="flex items-center gap-1 text-[10px] font-semibold text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded border border-slate-200 dark:border-slate-700">
              <Lock className="w-3 h-3 text-slate-500" /> Protected Information
            </span>
          </div>

          {isLoadingRequirements ? (
            <div className="flex items-center gap-2 py-8 text-xs text-slate-500 justify-center">
              <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
              <span>Loading verification requirements...</span>
            </div>
          ) : preCheck && preCheck.endUserRequirements.length > 0 ? (
            <div className="space-y-4">
              <p className="text-xs text-slate-500 dark:text-slate-400">
                We'll only ask for information required to register this number. Sensitive values are encrypted server-side before storage.
              </p>

              <div className="space-y-4">
                {preCheck.endUserRequirements
                  .filter((req) => {
                    const fk = (req.fieldKey || (req as any).type || '').toLowerCase();
                    return (
                      fk !== 'business_name' &&
                      fk !== 'business' &&
                      fk !== 'business_identity' &&
                      fk !== 'is_subassigned' &&
                      fk !== 'business_classification'
                    );
                  })
                  .map((req, idx) => {
                  const fieldKey = req.fieldKey || (req as any).type;
                  const compositeKey = `${fieldKey}__${fieldKey}`;
                  const currentVal = fieldInputs[compositeKey] || fieldInputs[`general_identity__${fieldKey}`] || '';
                  const isRequired = req.required !== false;

                  const hasOptions = Array.isArray(req.options) && req.options.length > 0;
                  const isRadio = hasOptions && (req.inputType === 'radio' || req.options!.length <= 4);

                  return (
                    <div key={idx} className="space-y-1.5 p-3.5 rounded-xl bg-slate-50 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800">
                      <label className="text-xs font-semibold text-slate-900 dark:text-slate-100 flex items-center justify-between">
                        <span className="flex items-center gap-1">
                          {req.friendlyName || fieldKey.replace(/_/g, ' ')}
                          {isRequired && <span className="text-rose-500 font-bold">*</span>}
                        </span>
                      </label>

                      {req.description && (
                        <div className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                          {renderSafeProviderText(req.description)}
                        </div>
                      )}

                      {isRadio ? (
                        <div className="flex flex-wrap items-center gap-2 pt-1">
                          {req.options!.map((opt) => (
                            <label
                              key={opt.value}
                              className={`px-3.5 py-2 rounded-lg text-xs font-semibold border cursor-pointer transition-all flex items-center gap-2 ${
                                currentVal === opt.value
                                  ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
                                  : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800'
                              }`}
                            >
                              <input
                                type="radio"
                                name={compositeKey}
                                value={opt.value}
                                checked={currentVal === opt.value}
                                onChange={(e) => setFieldInputs((prev) => ({ ...prev, [compositeKey]: e.target.value }))}
                                className="sr-only"
                              />
                              <span>{opt.label || opt.value}</span>
                            </label>
                          ))}
                        </div>
                      ) : hasOptions ? (
                        <select
                          value={currentVal}
                          onChange={(e) => setFieldInputs((prev) => ({ ...prev, [compositeKey]: e.target.value }))}
                          className="w-full h-9 px-3 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                        >
                          <option value="">Select {req.friendlyName || fieldKey}...</option>
                          {req.options!.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label || opt.value}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type={req.inputType || 'text'}
                          placeholder={`Enter ${req.friendlyName ? req.friendlyName.toLowerCase() : fieldKey}...`}
                          value={currentVal}
                          onChange={(e) =>
                            setFieldInputs((prev) => ({ ...prev, [compositeKey]: e.target.value }))
                          }
                          className="w-full h-9 px-3 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      )}
                    </div>
                  );
                })}
              </div>

              {saveSuccess && (
                <div className="p-2.5 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-xs text-emerald-800 dark:text-emerald-300 flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                  <span>{saveSuccess}</span>
                </div>
              )}

              {profileError && (
                <div className="p-2.5 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-xs text-rose-700 dark:text-rose-300">
                  {profileError}
                </div>
              )}

              <div className="flex items-center justify-between pt-2">
                <Button variant="outline" onClick={() => setActiveStep(1)} className="text-xs">
                  &larr; Back
                </Button>
                <Button
                  onClick={handleSaveFields}
                  disabled={isSavingFields}
                  className="text-xs bg-blue-600 hover:bg-blue-700 text-white font-semibold flex items-center gap-1.5"
                >
                  {isSavingFields ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                  <span>Save & Next: Documents &rarr;</span>
                </Button>
              </div>
            </div>
          ) : (
            <div className="py-6 text-center text-xs text-slate-500">
              No additional text fields required for this regulation category. You may proceed to documents.
              <div className="mt-3">
                <Button onClick={() => setActiveStep(3)} className="text-xs bg-blue-600 text-white">
                  Next: Documents &rarr;
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}

      {/* STEP 3: REQUIRED DOCUMENTS (SINGLE-DOCUMENT ACTIVE CARDINALITY & IMMEDIATE RECONCILIATION) */}
      {activeStep === 3 && activeProfile && (
        <Card className="p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
            <span className="text-xs font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
              <Upload className="w-4 h-4 text-blue-500" />
              <span>Step 3: Document Requirements</span>
            </span>
            <span className="text-[10px] font-semibold text-slate-500">
              PDF, JPEG, PNG (Max 5MB each)
            </span>
          </div>

          {uploadError && (
            <div className="p-2.5 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-xs text-rose-700 dark:text-rose-300">
              {uploadError}
            </div>
          )}

          {preCheck && preCheck.supportingDocumentRequirements.length > 0 ? (
            <div className="space-y-4">
              {preCheck.supportingDocumentRequirements.map((docReq, idx) => {
                const reqKey = docReq.requirementKey || (docReq as any).type;
                const existingDocs = (activeProfile.documents || []).filter((d) => d.requirementKey === reqKey);
                const currentDoc = existingDocs.length > 0 ? existingDocs[existingDocs.length - 1] : null;
                const isUploading = uploadingKey === reqKey;

                return (
                  <div key={idx} className="p-4 rounded-xl bg-slate-50 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="space-y-1.5 flex-1">
                        <span className="text-xs font-bold text-slate-900 dark:text-slate-100 block">
                          {docReq.name || reqKey.replace(/_/g, ' ')}
                        </span>
                        {docReq.description && (
                          <div className="text-[11px] text-slate-600 dark:text-slate-400 leading-relaxed bg-white dark:bg-slate-900/60 p-3 rounded-lg border border-slate-200 dark:border-slate-800 space-y-1">
                            <span className="font-semibold text-slate-700 dark:text-slate-300 block">Requirement Details:</span>
                            <div className="whitespace-pre-wrap text-[11px]">{renderSafeProviderText(docReq.description)}</div>
                          </div>
                        )}
                        {docReq.acceptedDocuments && docReq.acceptedDocuments.length > 0 && (
                          <div className="text-[11px] text-slate-600 dark:text-slate-400 pt-0.5">
                            <strong className="text-slate-700 dark:text-slate-300">Accepted Document Options:</strong>{' '}
                            {docReq.acceptedDocuments.map((ad) => ad.name).join(' • ')}
                          </div>
                        )}
                      </div>
                      {currentDoc ? (
                        <span className="flex items-center gap-1 text-[10px] font-semibold text-emerald-600 bg-emerald-50 dark:bg-emerald-950/40 px-2.5 py-1 rounded-full border border-emerald-200 dark:border-emerald-800 shrink-0">
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" /> Uploaded ✓
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-[10px] font-semibold text-rose-600 bg-rose-50 dark:bg-rose-950/40 px-2.5 py-1 rounded-full border border-rose-200 dark:border-rose-900 shrink-0">
                          <AlertTriangle className="w-3.5 h-3.5 text-rose-500" /> Required — Not Uploaded
                        </span>
                      )}
                    </div>

                    {/* Active Document View / Replace Options */}
                    {currentDoc ? (
                      <div className="p-3 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3 text-xs">
                        <div className="flex items-center gap-2 truncate">
                          <FileText className="w-4 h-4 text-blue-500 shrink-0" />
                          <span className="font-semibold text-slate-800 dark:text-slate-200 truncate">
                            {currentDoc.originalFilename}
                          </span>
                          <span className="text-[10px] text-slate-400 shrink-0">
                            ({(currentDoc.sizeBytes / 1024 / 1024).toFixed(2)} MB)
                          </span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <Button
                            variant="outline"
                            onClick={() => handleDownloadDocument(currentDoc.id, currentDoc.originalFilename)}
                            className="h-7 px-2 text-[10px] flex items-center gap-1"
                          >
                            <Download className="w-3 h-3 text-blue-500" />
                            <span>Download</span>
                          </Button>

                          <label className="cursor-pointer inline-flex items-center gap-1 px-2.5 h-7 rounded bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-[10px] font-semibold text-slate-700 dark:text-slate-300 transition-colors">
                            {isUploading ? <Loader2 className="w-3 h-3 animate-spin text-blue-500" /> : <Upload className="w-3 h-3 text-blue-500" />}
                            <span>{isUploading ? 'Uploading...' : 'Replace File'}</span>
                            <input
                              type="file"
                              accept="application/pdf,image/jpeg,image/png"
                              disabled={isUploading}
                              onChange={(e) => {
                                const f = e.target.files?.[0];
                                if (f) {
                                  const docType = docReq.acceptedDocuments?.[0]?.type || reqKey;
                                  handleFileUpload(reqKey, docType, f);
                                }
                              }}
                              className="hidden"
                            />
                          </label>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-3 pt-1">
                        <label className="cursor-pointer inline-flex items-center gap-1.5 px-3 h-8 rounded-lg bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800">
                          {isUploading ? <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-500" /> : <Upload className="w-3.5 h-3.5 text-blue-500" />}
                          <span>{isUploading ? 'Uploading & Validating...' : 'Select File (PDF/JPG/PNG)'}</span>
                          <input
                            type="file"
                            accept="application/pdf,image/jpeg,image/png"
                            disabled={isUploading}
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) {
                                const docType = docReq.acceptedDocuments?.[0]?.type || reqKey;
                                handleFileUpload(reqKey, docType, f);
                              }
                            }}
                            className="hidden"
                          />
                        </label>
                      </div>
                    )}
                  </div>
                );
              })}

              <div className="flex items-center justify-between pt-2">
                <Button variant="outline" onClick={() => setActiveStep(2)} className="text-xs">
                  &larr; Back to Required Info
                </Button>
                <Button onClick={() => setActiveStep(4)} className="text-xs bg-blue-600 hover:bg-blue-700 text-white font-semibold">
                  Next: Final Review &rarr;
                </Button>
              </div>
            </div>
          ) : (
            <div className="py-6 text-center text-xs text-slate-500">
              No additional document uploads required for this regulation category. You may proceed to review.
              <div className="mt-3">
                <Button onClick={() => setActiveStep(4)} className="text-xs bg-blue-600 text-white">
                  Next: Review &rarr;
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}

      {/* STEP 4: REVIEW & READINESS CHECK */}
      {activeStep === 4 && activeProfile && (
        <Card className="p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
            <span className="text-xs font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
              <FileCheck className="w-4 h-4 text-blue-500" />
              <span>Step 4: Verification Readiness & Submission</span>
            </span>
            <span className="px-2.5 py-0.5 rounded text-[10px] font-bold uppercase bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
              Status: {(activeProfile.status as string).replace(/_/g, ' ')}
            </span>
          </div>

          <div className="space-y-3 text-xs">
            <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 space-y-2">
              <span className="text-[10px] font-bold text-slate-400 block uppercase">PROFILE SUMMARY</span>
              <div className="grid grid-cols-2 gap-2 text-slate-700 dark:text-slate-300">
                <div>Legal Name: <strong>{activeProfile.legalName}</strong></div>
                <div>Country: <strong>{activeProfile.countryCode}</strong></div>
                <div>Category: <strong>{numberType}</strong></div>
                <div>Registration: <strong>{endUserType}</strong></div>
                <div>Text Fields Saved: <strong>{activeProfile.fieldValues.length}</strong></div>
                <div>Documents Uploaded: <strong>{(activeProfile.documents || []).length}</strong></div>
              </div>
            </div>

            {/* Submission Error Banner */}
            {submissionError && (
              <div className="p-3.5 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-rose-800 dark:text-rose-300 space-y-1">
                <span className="font-bold text-xs flex items-center gap-1.5">
                  <AlertTriangle className="w-4 h-4 text-rose-600" /> Submission Error
                </span>
                <p className="text-[11px] text-rose-700 dark:text-rose-300">{submissionError}</p>
              </div>
            )}

            {/* Simulated / Disabled Mutations Banner */}
            {submissionResult?.simulated && (
              <div className="p-4 rounded-xl bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 text-blue-900 dark:text-blue-200 space-y-1.5">
                <span className="font-bold flex items-center gap-1.5 text-blue-700 dark:text-blue-400">
                  <CheckCircle2 className="w-4 h-4 text-blue-500" /> Provider Preflight Validated (Mutations Disabled)
                </span>
                <p className="text-[11px] text-blue-800 dark:text-blue-300 leading-relaxed">
                  Profile preflight validation passed successfully. Live provider mutations are currently disabled in this environment. No live Twilio resources were created.
                </p>
              </div>
            )}

            {/* Status-Specific Information & Missing Items Banners */}
            {preCheck && activeProfile.status !== 'ready_for_submission' && (
              (() => {
                const missingFields = (preCheck.endUserRequirements || []).filter(
                  (req) =>
                    req.required !== false &&
                    req.fieldKey !== 'business_identity' &&
                    req.fieldKey !== 'is_subassigned' &&
                    req.fieldKey !== 'business_classification' &&
                    !fieldInputs[`${req.fieldKey}__${req.fieldKey}`] &&
                    !fieldInputs[`general_identity__${req.fieldKey}`] &&
                    !(activeProfile.fieldValues || []).some((fv) => fv.fieldName === req.fieldKey)
                );
                const missingDocs = (preCheck.supportingDocumentRequirements || []).filter(
                  (req) =>
                    req.fileEvidenceRequired !== false &&
                    !(activeProfile.documents || []).some(
                      (d) => d.requirementKey === req.requirementKey && Boolean(d.storageObjectPath)
                    )
                );

                if (missingFields.length > 0 || missingDocs.length > 0) {
                  return (
                    <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 space-y-2">
                      <span className="font-bold flex items-center gap-1.5 text-amber-800 dark:text-amber-300 text-xs">
                        <AlertTriangle className="w-4 h-4 text-amber-600" /> Additional Requirements Pending
                      </span>
                      <p className="text-[11px] text-amber-800 dark:text-amber-300">
                        The following required items must be completed before local readiness:
                      </p>
                      <ul className="list-disc list-inside text-[11px] text-amber-900 dark:text-amber-200 space-y-1 font-medium">
                        {missingFields.map((f) => (
                          <li key={f.fieldKey}>
                            Step 2 Field: <strong>{f.friendlyName || f.fieldKey}</strong>
                          </li>
                        ))}
                        {missingDocs.map((d) => (
                          <li key={d.requirementKey}>
                            Step 3 Document: <strong>{d.name || d.requirementKey}</strong> — <span className="text-rose-600 dark:text-rose-400 font-bold">Required — Not Uploaded</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                }
                return null;
              })()
            )}

            {activeProfile.status === 'ready_for_submission' && !submissionResult?.simulated && (
              <div className="p-4 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-emerald-900 dark:text-emerald-200 space-y-2">
                <span className="font-bold flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
                  <CheckCircle2 className="w-4 h-4" /> Ready for Verification Submission
                </span>
                <p className="text-[11px] text-emerald-800 dark:text-emerald-300 leading-relaxed">
                  Your required information and supporting documents have been securely collected and stored with AES-256 encryption. Click below to initiate server-authoritative provider verification submission.
                </p>

                <div className="pt-1">
                  <Button
                    onClick={handleStartSubmission}
                    disabled={isSubmittingProfile}
                    className="text-xs bg-emerald-600 hover:bg-emerald-700 text-white font-semibold flex items-center gap-2"
                  >
                    {isSubmittingProfile ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
                    <span>Submit for Verification</span>
                  </Button>
                </div>
              </div>
            )}

            {activeProfile.status !== 'ready_for_submission' && activeProfile.status !== 'draft' && activeProfile.status !== 'information_required' && (
              <div className="p-4 rounded-xl bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 space-y-2">
                <span className="font-bold text-blue-700 dark:text-blue-400 flex items-center gap-1.5">
                  <Info className="w-4 h-4" /> Provider Review in Progress: {(activeProfile.status as string).replace(/_/g, ' ')}
                </span>
                <p className="text-[11px] text-blue-800 dark:text-blue-300">
                  Your verification request has been submitted and is currently being evaluated by provider regulatory compliance.
                </p>
                <Button
                  variant="outline"
                  onClick={handleSyncStatus}
                  disabled={isSyncingStatus}
                  className="text-xs flex items-center gap-1.5"
                >
                  {isSyncingStatus ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                  <span>Refresh Provider Status</span>
                </Button>
              </div>
            )}

            <div className="flex items-center justify-between pt-2">
              <Button variant="outline" onClick={() => setActiveStep(3)} className="text-xs">
                &larr; Back to Documents
              </Button>
              <Link href="/numbers/marketplace">
                <Button className="text-xs bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 font-semibold">
                  Return to Marketplace
                </Button>
              </Link>
            </div>
          </div>
        </Card>
      )}
      </>
    )}
    </div>
  );
}

export default function NumberVerificationPage() {
  return (
    <Suspense fallback={<div className="p-8 text-xs text-slate-500 text-center">Loading verification portal...</div>}>
      <VerificationContent />
    </Suspense>
  );
}
