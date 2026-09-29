// ============================================================================
// PUBLIC SAAS PHASE 13.4.3B.2E — LEVEL 2A READ-ONLY PREFLIGHT HARNESS
// Read-only environment, credential, capacity, safety budget, and cost verification.
// STRICT INVARIANT: ZERO REAL CALLS, ZERO MUTATIONS, ZERO DB WRITES.
// NO EXAMPLE PRICE FALLBACKS (MUST PROVIDE VERIFIED WHOLESALE PRICING DATA).
// ============================================================================

import {
  isProviderMutationGateEnabled,
  isExtendAllowanceScopeEnabled,
  isTerminateCallScopeEnabled,
  validatePreDispatchLeaseSafety,
} from './twilioCallControlAdapter';

export interface Level2APreflightResult {
  status: 'LEVEL_2A_PREFLIGHT_PASS' | 'LEVEL_2A_PREFLIGHT_FAIL';
  summary: string;
  checks: Record<string, { pass: boolean; details: string }>;
  calculatedMaxCostMinor: number;
  authorizedBudgetMinor: number;
  experimentLeaseSeconds: number;
  requiredSafetySeconds: number;
}

export interface Level2APreflightOptions {
  accountSid?: string;
  authToken?: string;
  controlledDestination?: string;
  ownedTestNumber?: string;
  verifiedWholesaleRateCentsPerMinute?: number;
  verifiedWholesaleBillingIncrementSeconds?: number;
  maxAuthorizedBudgetMinor?: number;
  experimentLeaseDurationSeconds?: number;
  initialTestLimitSeconds?: number;
  proposedExtendedLimitSeconds?: number;
  recordingEnabled?: boolean;
}

export async function runLevel2APreflight(
  options: Level2APreflightOptions = {}
): Promise<Level2APreflightResult> {
  const checks: Record<string, { pass: boolean; details: string }> = {};
  let overallPass = true;

  // 1. TWILIO CREDENTIALS CHECK (Never log secrets!)
  const accountSid = options.accountSid || process.env.TWILIO_ACCOUNT_SID;
  const authToken = options.authToken || process.env.TWILIO_AUTH_TOKEN;
  const credsValid = Boolean(accountSid && accountSid.startsWith('AC') && authToken && authToken.length > 10);
  checks.credentialsPresent = {
    pass: credsValid,
    details: credsValid
      ? `AccountSid present (${accountSid?.slice(0, 6)}... masked), AuthToken present.`
      : 'MISSING_OR_INVALID_TWILIO_CREDENTIALS: TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN missing or malformed.',
  };
  if (!credsValid) overallPass = false;

  // 2. OWNED TEST NUMBER CHECK
  const ownedNumber = options.ownedTestNumber || process.env.TWILIO_PHONE_NUMBER || process.env.LEVEL2_TEST_OWNED_NUMBER;
  const ownedNumberValid = Boolean(ownedNumber && ownedNumber.startsWith('+'));
  checks.ownedTestNumber = {
    pass: ownedNumberValid,
    details: ownedNumberValid
      ? `Owned test number configured: ${ownedNumber}`
      : 'MISSING_OWNED_TEST_NUMBER: Must configure an existing owned Twilio number for test origin.',
  };
  if (!ownedNumberValid) overallPass = false;

  // 3. CONTROLLED DESTINATION CHECK
  const destination = options.controlledDestination || process.env.LEVEL2_CONTROLLED_DESTINATION;
  const destValid = Boolean(destination && destination.startsWith('+'));
  checks.controlledDestination = {
    pass: destValid,
    details: destValid
      ? `Controlled test destination configured: ${destination}`
      : 'MISSING_CONTROLLED_DESTINATION: Must provide explicit controlled destination phone number.',
  };
  if (!destValid) overallPass = false;

  // 4. CALLBACK HTTPS BASE URL CHECK
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_BASE_URL || 'https://krispcall-voip-clone-udlg.vercel.app';
  const urlValid = baseUrl.startsWith('https://');
  checks.callbackHttpsUrl = {
    pass: urlValid,
    details: urlValid
      ? `Public HTTPS base URL configured: ${baseUrl}`
      : `INVALID_CALLBACK_URL: Base URL (${baseUrl}) must start with https:// for status webhook receipt.`,
  };
  if (!urlValid) overallPass = false;

  // 5. RECORDING SAFETY CHECK
  const recordingEnabled = options.recordingEnabled ?? false;
  checks.recordingDisabled = {
    pass: !recordingEnabled,
    details: !recordingEnabled
      ? 'Recording disabled for test path (prevents unbudgeted recording fees).'
      : 'RECORDING_ENABLED: Test path must have recording disabled unless explicitly intended.',
  };
  if (recordingEnabled) overallPass = false;

  // 6. MASTER & SCOPED PROVIDER MUTATION GATES CHECK
  const masterGate = isProviderMutationGateEnabled();
  const extendScope = isExtendAllowanceScopeEnabled();
  const terminateScope = isTerminateCallScopeEnabled();
  checks.providerMutationGates = {
    pass: true, // Read-only preflight reports gate status without mutating
    details: `MasterGate=${masterGate}, ExtendScope=${extendScope}, TerminateScope=${terminateScope}`,
  };

  // 7. TIMING & SAFETY BUDGET DERIVATION
  const initialLimitSec = options.initialTestLimitSeconds || 45;
  const extendedLimitSec = options.proposedExtendedLimitSeconds || 90;
  const expLeaseSec = options.experimentLeaseDurationSeconds || 300; // EXPERIMENT_ONLY default 300s

  const leaseSafety = validatePreDispatchLeaseSafety({
    remainingLeaseSeconds: expLeaseSec,
    requestTimeoutMs: 10000,
    readbackBudgetMs: 5000,
    terminationBudgetMs: 5000,
    safetyMarginMs: 10000,
  });

  checks.experimentLeaseSafety = {
    pass: leaseSafety.safe,
    details: leaseSafety.safe
      ? `Experiment lease (${expLeaseSec}s) >= required safety budget (${leaseSafety.requiredSafetySeconds}s).`
      : `INSUFFICIENT_EXPERIMENT_LEASE: Lease (${expLeaseSec}s) < required safety budget (${leaseSafety.requiredSafetySeconds}s).`,
  };
  if (!leaseSafety.safe) overallPass = false;

  // 8. STRICT PROVIDER WHOLESALE COST & BILLING INCREMENT VERIFICATION
  // NO EXAMPLE PRICE FALLBACKS PERMITTED. Must be explicitly verified from options or verified env.
  const verifiedRateCentsPerMin =
    options.verifiedWholesaleRateCentsPerMinute ??
    (process.env.LEVEL2_VERIFIED_WHOLESALE_RATE_CENTS_PER_MIN
      ? parseFloat(process.env.LEVEL2_VERIFIED_WHOLESALE_RATE_CENTS_PER_MIN)
      : undefined);

  const verifiedIncrementSec =
    options.verifiedWholesaleBillingIncrementSeconds ??
    (process.env.LEVEL2_VERIFIED_WHOLESALE_INCREMENT_SEC
      ? parseInt(process.env.LEVEL2_VERIFIED_WHOLESALE_INCREMENT_SEC, 10)
      : undefined);

  let calculatedMaxCostMinor = 0;
  const authorizedBudgetMinor = options.maxAuthorizedBudgetMinor ?? (parseInt(process.env.LEVEL_2_MAX_PROVIDER_COST_MINOR || '10', 10));

  if (verifiedRateCentsPerMin === undefined || verifiedIncrementSec === undefined || verifiedIncrementSec <= 0) {
    checks.providerCostVerified = {
      pass: false,
      details: 'PROVIDER_COST_NOT_VERIFIED: No verified wholesale provider price or billing increment available. Example fallbacks forbidden.',
    };
    overallPass = false;
  } else {
    // Calculate cost based on conservative provider billing increments
    const totalIntervals = Math.ceil(extendedLimitSec / verifiedIncrementSec);
    const costPerIntervalCents = (verifiedRateCentsPerMin * verifiedIncrementSec) / 60;
    calculatedMaxCostMinor = Math.ceil(totalIntervals * costPerIntervalCents);

    checks.providerCostVerified = {
      pass: true,
      details: `Verified wholesale rate: ${verifiedRateCentsPerMin}c/min, increment: ${verifiedIncrementSec}s. Max cost: ${calculatedMaxCostMinor}c.`,
    };

    const budgetPass = calculatedMaxCostMinor <= authorizedBudgetMinor;
    checks.providerCostBudget = {
      pass: budgetPass,
      details: budgetPass
        ? `Calculated max cost (${calculatedMaxCostMinor}c) <= authorized budget (${authorizedBudgetMinor}c).`
        : `COST_EXCEEDS_BUDGET: Calculated max cost (${calculatedMaxCostMinor}c) > authorized budget (${authorizedBudgetMinor}c).`,
    };
    if (!budgetPass) overallPass = false;
  }

  const status = overallPass ? 'LEVEL_2A_PREFLIGHT_PASS' : 'LEVEL_2A_PREFLIGHT_FAIL';
  const summary = overallPass
    ? `Level 2A Read-Only Preflight PASSED. All credentials, safety budgets (${expLeaseSec}s lease), and verified cost bounds (${calculatedMaxCostMinor}c <= ${authorizedBudgetMinor}c) verified.`
    : `Level 2A Read-Only Preflight FAILED. Inspect checks object for details. Zero calls placed.`;

  return {
    status,
    summary,
    checks,
    calculatedMaxCostMinor,
    authorizedBudgetMinor,
    experimentLeaseSeconds: expLeaseSec,
    requiredSafetySeconds: leaseSafety.requiredSafetySeconds,
  };
}
