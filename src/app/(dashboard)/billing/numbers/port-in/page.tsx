'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import {
  ArrowLeft,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  ShieldCheck,
  Building2,
  FileText,
  Lock,
  Clock,
  HelpCircle,
} from 'lucide-react';

export default function CustomerPortInPage() {
  const [step, setStep] = useState<number>(1);
  const [phoneNumberE164, setPhoneNumberE164] = useState<string>('');
  const [countryCode, setCountryCode] = useState<string>('US');
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Portability Result State
  const [portabilityResult, setPortabilityResult] = useState<any | null>(null);
  const [operationId, setOperationId] = useState<string | null>(null);

  // Form details
  const [accountNumber, setAccountNumber] = useState<string>('');
  const [pin, setPin] = useState<string>('');
  const [repName, setRepName] = useState<string>('');
  const [repEmail, setRepEmail] = useState<string>('');
  const [carrierName, setCarrierName] = useState<string>('');

  const handleCheckPortability = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!phoneNumberE164) return;

    try {
      setLoading(true);
      setError(null);

      const res = await fetch('/api/number-marketplace/port-in/check-portability', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phoneNumberE164,
          countryCode,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Portability check failed.');
      }

      setPortabilityResult(data.portability);
      setStep(2);
    } catch (err: any) {
      setError(err.message || 'Portability check error.');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateDraftAndSaveDetails = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setLoading(true);
      setError(null);

      // Create draft operation if not already created
      let opId = operationId;
      if (!opId) {
        const createRes = await fetch('/api/number-marketplace/port-in/operations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            organizationId: '00000000-0000-0000-0000-000000000001', // Mock organization for UI preview
            phoneNumberE164: portabilityResult.phoneNumberE164,
            workflowMode: portabilityResult.workflowMode,
          }),
        });
        const createData = await createRes.json();
        if (!createRes.ok || !createData.success) {
          throw new Error(createData.error || 'Failed to create port draft.');
        }
        opId = createData.operation.operationId;
        setOperationId(opId);
      }

      // Save details & encrypted secrets
      const updateRes = await fetch(`/api/number-marketplace/port-in/operations/${opId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organizationId: '00000000-0000-0000-0000-000000000001',
          accountNumberPlaintext: accountNumber,
          pinPlaintext: pin,
          authorizedRepresentativeName: repName,
          authorizedRepresentativeEmail: repEmail,
          carrierName,
        }),
      });

      const updateData = await updateRes.json();
      if (!updateRes.ok || !updateData.success) {
        throw new Error(updateData.error || 'Failed to update details.');
      }

      setStep(3);
    } catch (err: any) {
      setError(err.message || 'Failed to save porting details.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6 max-w-3xl mx-auto pb-12">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-slate-200 dark:border-slate-800 pb-4">
        <Link href="/billing/numbers">
          <Button variant="outline" size="sm" className="p-2">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <span>Port Existing Phone Number</span>
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Transfer your existing phone number from another carrier into VoIP Hub.
          </p>
        </div>
      </div>

      {/* Progress Steps */}
      <div className="flex items-center justify-between px-4 py-3 bg-slate-50 dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 text-xs font-medium">
        <div className={`flex items-center gap-2 ${step >= 1 ? 'text-indigo-600 dark:text-indigo-400 font-bold' : 'text-slate-400'}`}>
          <span className="w-5 h-5 rounded-full bg-indigo-500/10 flex items-center justify-center text-[10px]">1</span>
          <span>Check Eligibility</span>
        </div>
        <div className="h-px w-8 bg-slate-200 dark:bg-slate-800" />
        <div className={`flex items-center gap-2 ${step >= 2 ? 'text-indigo-600 dark:text-indigo-400 font-bold' : 'text-slate-400'}`}>
          <span className="w-5 h-5 rounded-full bg-indigo-500/10 flex items-center justify-center text-[10px]">2</span>
          <span>Requirements</span>
        </div>
        <div className="h-px w-8 bg-slate-200 dark:bg-slate-800" />
        <div className={`flex items-center gap-2 ${step >= 3 ? 'text-indigo-600 dark:text-indigo-400 font-bold' : 'text-slate-400'}`}>
          <span className="w-5 h-5 rounded-full bg-indigo-500/10 flex items-center justify-center text-[10px]">3</span>
          <span>Review &amp; Confirm</span>
        </div>
      </div>

      {error && (
        <Card className="border-rose-500/20 bg-rose-500/5 p-4 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-rose-500 shrink-0 mt-0.5" />
          <div className="text-xs text-rose-700 dark:text-rose-300 font-medium">
            {error}
          </div>
        </Card>
      )}

      {/* STEP 1: Check Portability */}
      {step === 1 && (
        <Card className="p-6 space-y-4">
          <CardHeader className="p-0 border-b-0">
            <CardTitle className="text-sm font-bold flex items-center gap-2">
              <Building2 className="w-4 h-4 text-indigo-500" />
              <span>Step 1: Enter Phone Number to Port</span>
            </CardTitle>
          </CardHeader>

          <form onSubmit={handleCheckPortability} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                Phone Number (E.164 Format)
              </label>
              <input
                type="text"
                value={phoneNumberE164}
                onChange={(e) => setPhoneNumberE164(e.target.value)}
                placeholder="+1 (202) 555-0199"
                required
                className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-800 text-sm font-mono focus:ring-2 focus:ring-indigo-500 focus:outline-none bg-transparent"
              />
              <p className="text-[11px] text-slate-500">
                Enter the full international format number (e.g. +12025550199 or +442079460999).
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                Country
              </label>
              <select
                value={countryCode}
                onChange={(e) => setCountryCode(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-800 text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none bg-transparent"
              >
                <option value="US">United States (+1)</option>
                <option value="CA">Canada (+1)</option>
                <option value="GB">United Kingdom (+44)</option>
                <option value="AU">Australia (+61)</option>
              </select>
            </div>

            <div className="pt-2">
              <Button type="submit" variant="primary" size="md" disabled={loading} className="w-full">
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    <span>Checking Portability...</span>
                  </>
                ) : (
                  <span>Check Portability</span>
                )}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {/* STEP 2: Requirements & Details */}
      {step === 2 && portabilityResult && (
        <Card className="p-6 space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-slate-800">
            <div>
              <div className="text-xs text-slate-500">Selected Number</div>
              <div className="text-base font-mono font-bold">{portabilityResult.phoneNumberE164}</div>
            </div>
            <Badge variant={portabilityResult.portable ? 'emerald' : 'rose'}>
              {portabilityResult.portable ? 'Eligible for Port-In' : 'Unsupported'}
            </Badge>
          </div>

          <form onSubmit={handleCreateDraftAndSaveDetails} className="space-y-4">
            <div className="p-3 rounded-lg bg-indigo-500/5 border border-indigo-500/20 text-xs space-y-1">
              <div className="font-semibold text-indigo-900 dark:text-indigo-200 flex items-center gap-1.5">
                <ShieldCheck className="w-4 h-4 text-indigo-500" />
                <span>Pre-filled Workspace Verification</span>
              </div>
              <p className="text-slate-600 dark:text-slate-400">
                VoIP Hub automatically applies your workspace regulatory compliance profile for address and identity verification.
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                Current Carrier Name
              </label>
              <input
                type="text"
                value={carrierName}
                onChange={(e) => setCarrierName(e.target.value)}
                placeholder="e.g. Verizon / AT&T"
                required
                className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-800 text-sm focus:outline-none bg-transparent"
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-700 dark:text-slate-300 flex items-center justify-between">
                  <span>Account Number</span>
                  <Lock className="w-3 h-3 text-slate-400" />
                </label>
                <input
                  type="text"
                  value={accountNumber}
                  onChange={(e) => setAccountNumber(e.target.value)}
                  placeholder="Losing carrier account number"
                  required
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-800 text-sm focus:outline-none bg-transparent"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-700 dark:text-slate-300 flex items-center justify-between">
                  <span>Porting PIN / Passcode</span>
                  <Lock className="w-3 h-3 text-slate-400" />
                </label>
                <input
                  type="password"
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  placeholder="PIN or Security Passcode"
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-800 text-sm focus:outline-none bg-transparent"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  Authorized Representative Name
                </label>
                <input
                  type="text"
                  value={repName}
                  onChange={(e) => setRepName(e.target.value)}
                  placeholder="Full Legal Name"
                  required
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-800 text-sm focus:outline-none bg-transparent"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  Authorized Representative Email
                </label>
                <input
                  type="email"
                  value={repEmail}
                  onChange={(e) => setRepEmail(e.target.value)}
                  placeholder="name@company.com"
                  required
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-800 text-sm focus:outline-none bg-transparent"
                />
              </div>
            </div>

            <div className="pt-2 flex items-center gap-3">
              <Button type="button" variant="outline" size="md" onClick={() => setStep(1)}>
                Back
              </Button>
              <Button type="submit" variant="primary" size="md" disabled={loading} className="flex-1">
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <span>Continue to Review</span>}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {/* STEP 3: Review & Confirm */}
      {step === 3 && (
        <Card className="p-6 space-y-4">
          <CardHeader className="p-0 border-b-0">
            <CardTitle className="text-sm font-bold flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-500" />
              <span>Step 3: Review &amp; Confirm Port Request</span>
            </CardTitle>
          </CardHeader>

          <div className="space-y-3 divide-y divide-slate-100 dark:divide-slate-800 text-xs">
            <div className="py-2 flex items-center justify-between">
              <span className="text-slate-500">Phone Number:</span>
              <span className="font-mono font-bold text-slate-900 dark:text-slate-100">{portabilityResult?.phoneNumberE164}</span>
            </div>
            <div className="py-2 flex items-center justify-between">
              <span className="text-slate-500">Losing Carrier:</span>
              <span className="font-medium text-slate-900 dark:text-slate-100">{carrierName || 'Configured'}</span>
            </div>
            <div className="py-2 flex items-center justify-between">
              <span className="text-slate-500">Authorized Person:</span>
              <span className="font-medium text-slate-900 dark:text-slate-100">{repName} ({repEmail})</span>
            </div>
            <div className="py-2 flex items-center justify-between">
              <span className="text-slate-500">VoIP Hub Porting Charge:</span>
              <span className="font-bold text-emerald-600 dark:text-emerald-400">$0.00 USD</span>
            </div>
          </div>

          <div className="p-3 rounded-lg bg-amber-500/5 border border-amber-500/20 text-xs space-y-1">
            <div className="font-semibold text-amber-900 dark:text-amber-200 flex items-center gap-1.5">
              <Clock className="w-4 h-4 text-amber-500" />
              <span>Next Steps After Confirmation</span>
            </div>
            <p className="text-slate-600 dark:text-slate-400">
              An electronic Letter of Authorization (LOA) signature link will be emailed to {repEmail}. Your port will process automatically once signed.
            </p>
          </div>

          <div className="pt-2 flex items-center gap-3">
            <Button type="button" variant="outline" size="md" onClick={() => setStep(2)}>
              Back to Details
            </Button>

            <Link href="/billing/numbers" className="flex-1">
              <Button variant="primary" size="md" className="w-full">
                Confirm &amp; Track Port Status
              </Button>
            </Link>
          </div>
        </Card>
      )}
    </div>
  );
}
