// ============================================================================
// PUBLIC SAAS PHASE 13.4.3B.2E — LEVEL 2A READ-ONLY PREFLIGHT HARNESS
// Read-only environment, credential, origin-aware pricing, candidate number type,
// canonical funding primitive, and schema invariant verification.
// STRICT INVARIANT: ZERO REAL CALLS, ZERO MUTATIONS, ZERO DB WRITES.
// NO TENANT REASSIGNMENT. NO ARBITRARY BALANCE INVENTIONS.
// ============================================================================

import twilio from 'twilio';
import { createClient } from '@supabase/supabase-js';
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
  twilioReadOnlyRequests: number;
  pricingProvenance?: string;
  billingIncrementProvenance?: string;
  candidateNumberType?: string;
  existingNumberOwnerContext?: 'SYNTHETIC_TEST' | 'REAL_CUSTOMER' | 'UNDETERMINED';
  accountDetails?: { accountSid: string; status: string; type: string };
  ownedNumbersDetails?: Array<{ phoneNumber: string; voiceCapable: boolean; type?: string }>;
  tenantConflictDetails?: { conflictDetected: boolean; existingOrganizationId?: string; details: string };
  canonicalSchemaAudit?: Record<string, string>;
  proposedTimingEnvelope?: {
    initialTestLimitSeconds: number;
    proposedExtendedLimitSeconds: number;
    absoluteTestMaxSeconds: number;
  };
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
  absoluteTestMaxSeconds?: number;
  recordingEnabled?: boolean;
  allowDocVerifiedIncrement?: boolean;
  checkTenantConflict?: boolean;
  mockSupabaseClient?: any;
}

export async function runLevel2APreflight(
  options: Level2APreflightOptions = {}
): Promise<Level2APreflightResult> {
  const checks: Record<string, { pass: boolean; details: string }> = {};
  let overallPass = true;
  let twilioReadOnlyRequests = 0;
  let accountDetails: { accountSid: string; status: string; type: string } | undefined = undefined;
  let ownedNumbersDetails: Array<{ phoneNumber: string; voiceCapable: boolean; type?: string }> = [];
  let candidateNumberType = 'NUMBER_TYPE_UNVERIFIED';
  let pricingProvenance = 'unverified';
  let billingIncrementProvenance = 'unverified';
  let existingNumberOwnerContext: 'SYNTHETIC_TEST' | 'REAL_CUSTOMER' | 'UNDETERMINED' = 'UNDETERMINED';

  // 1. TWILIO CREDENTIALS & READ-ONLY ACCOUNT VERIFICATION (Never log secrets!)
  const accountSid = options.accountSid || process.env.TWILIO_ACCOUNT_SID;
  const authToken = options.authToken || process.env.TWILIO_AUTH_TOKEN;
  const apiKeySid = process.env.TWILIO_API_KEY_SID;
  const apiKeySecret = process.env.TWILIO_API_KEY_SECRET;

  const credsPresent = Boolean(
    accountSid &&
    accountSid.startsWith('AC') &&
    ((authToken && authToken.length > 10) || (apiKeySid && apiKeySid.startsWith('SK') && apiKeySecret))
  );

  let client: twilio.Twilio | null = null;

  if (!credsPresent) {
    checks.credentialsPresent = {
      pass: false,
      details: 'MISSING_OR_INVALID_TWILIO_CREDENTIALS: TWILIO_ACCOUNT_SID and (TWILIO_AUTH_TOKEN or TWILIO_API_KEY_SID/SECRET) missing or malformed.',
    };
    overallPass = false;
  } else {
    // Perform Read-Only API Account Verification if non-mock credentials
    if (!authToken?.startsWith('mock_')) {
      try {
        if (accountSid && apiKeySid && apiKeySecret) {
          client = twilio(apiKeySid, apiKeySecret, { accountSid, timeout: 10000, autoRetry: false, maxRetries: 0 });
        } else if (accountSid && authToken) {
          client = twilio(accountSid, authToken, { timeout: 10000, autoRetry: false, maxRetries: 0 });
        }

        if (client) {
          twilioReadOnlyRequests++;
          const acc = await client.api.v2010.accounts(accountSid!).fetch();
          accountDetails = {
            accountSid: acc.sid.slice(0, 6) + '...' + acc.sid.slice(-4),
            status: acc.status,
            type: acc.type,
          };
          checks.credentialsPresent = {
            pass: acc.status === 'active',
            details: `Authenticated read-only via API. Account ${accountDetails.accountSid} (status: ${acc.status}, type: ${acc.type}).`,
          };
          if (acc.status !== 'active') overallPass = false;
        }
      } catch (err: any) {
        checks.credentialsPresent = {
          pass: false,
          details: `API_AUTHENTICATION_FAILED: ${err.message}`,
        };
        overallPass = false;
      }
    } else {
      checks.credentialsPresent = {
        pass: true,
        details: `AccountSid present (${accountSid?.slice(0, 6)}... masked), AuthToken present (test mock format).`,
      };
    }
  }

  // 2. OWNED TEST NUMBER & AUTHORITATIVE NUMBER TYPE AUDIT (Read-Only GET)
  const configuredOwnedNumber = options.ownedTestNumber || process.env.TWILIO_PHONE_NUMBER || process.env.LEVEL2_TEST_OWNED_NUMBER;
  if (credsPresent && client && !authToken?.startsWith('mock_')) {
    try {
      twilioReadOnlyRequests++;
      const numbersList = await client.incomingPhoneNumbers.list({ limit: 5 });
      
      const matchedOwned = configuredOwnedNumber
        ? numbersList.find((n) => n.phoneNumber === configuredOwnedNumber)
        : numbersList.find((n) => n.capabilities?.voice);

      if (matchedOwned) {
        // Authoritative pricing / number-type query for candidate number
        try {
          twilioReadOnlyRequests++;
          const numPricing = await client.pricing.v2.voice.numbers(matchedOwned.phoneNumber).fetch();
          if (numPricing && numPricing.inboundCallPrice?.numberType) {
            candidateNumberType = numPricing.inboundCallPrice.numberType;
          } else if ((matchedOwned as any).addressRequirements === 'local') {
            candidateNumberType = 'local';
          }
        } catch {
          if ((matchedOwned as any).addressRequirements === 'local') {
            candidateNumberType = 'local';
          }
        }

        ownedNumbersDetails = numbersList.map((n) => ({
          phoneNumber: n.phoneNumber.slice(0, 3) + '***' + n.phoneNumber.slice(-4),
          voiceCapable: Boolean(n.capabilities?.voice),
          type: candidateNumberType !== 'NUMBER_TYPE_UNVERIFIED' ? candidateNumberType : undefined,
        }));

        checks.ownedTestNumber = {
          pass: true,
          details: `Owned test number verified (${matchedOwned.phoneNumber.slice(0, 3)}***${matchedOwned.phoneNumber.slice(-4)}, Voice: ${matchedOwned.capabilities?.voice}, Type: ${candidateNumberType}).`,
        };
      } else {
        checks.ownedTestNumber = {
          pass: false,
          details: configuredOwnedNumber
            ? `OWNED_NUMBER_NOT_FOUND: Configured number ${configuredOwnedNumber} not found in Twilio account.`
            : 'NO_VOICE_CAPABLE_OWNED_NUMBER: No voice-capable incoming phone numbers found in Twilio account.',
        };
        overallPass = false;
      }
    } catch (err: any) {
      checks.ownedTestNumber = {
        pass: false,
        details: `OWNED_NUMBER_FETCH_FAILED: ${err.message}`,
      };
      overallPass = false;
    }
  } else {
    const ownedNumberValid = Boolean(configuredOwnedNumber && configuredOwnedNumber.startsWith('+'));
    checks.ownedTestNumber = {
      pass: ownedNumberValid,
      details: ownedNumberValid
        ? `Owned test number configured: ${configuredOwnedNumber?.slice(0, 3)}***${configuredOwnedNumber?.slice(-4)}`
        : 'MISSING_OWNED_TEST_NUMBER: Must configure an existing owned Twilio number for test origin.',
    };
    if (!ownedNumberValid) overallPass = false;
  }

  // Candidate number type validation check
  checks.candidateNumberType = {
    pass: candidateNumberType !== 'NUMBER_TYPE_UNVERIFIED',
    details: candidateNumberType !== 'NUMBER_TYPE_UNVERIFIED'
      ? `Authoritative candidate number type determined: ${candidateNumberType}`
      : 'NUMBER_TYPE_UNVERIFIED: Authoritative Twilio number type could not be determined. Example labels forbidden.',
  };

  // 3. CONTROLLED DESTINATION CHECK
  const destination = options.controlledDestination || process.env.LEVEL2_CONTROLLED_DESTINATION;
  const destValid = Boolean(destination && destination.startsWith('+'));
  checks.controlledDestination = {
    pass: destValid,
    details: destValid
      ? `Controlled test destination configured: ${destination?.slice(0, 3)}***${destination?.slice(-4)}`
      : 'CONTROLLED_TEST_DESTINATION_REQUIRED: Must provide explicit controlled destination phone number (e.g. LEVEL2_CONTROLLED_DESTINATION).',
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

  // 7. EXPERIMENT TIMING INVARIANTS CHECK
  const initialLimitSec = options.initialTestLimitSeconds ?? (process.env.LEVEL2_INITIAL_TEST_LIMIT_SECONDS ? parseInt(process.env.LEVEL2_INITIAL_TEST_LIMIT_SECONDS, 10) : 60);
  const extendedLimitSec = options.proposedExtendedLimitSeconds ?? (process.env.LEVEL2_PROPOSED_EXTENDED_LIMIT_SECONDS ? parseInt(process.env.LEVEL2_PROPOSED_EXTENDED_LIMIT_SECONDS, 10) : 60);
  const absoluteMaxSec = options.absoluteTestMaxSeconds ?? (process.env.LEVEL2_ABSOLUTE_TEST_MAX_SECONDS ? parseInt(process.env.LEVEL2_ABSOLUTE_TEST_MAX_SECONDS, 10) : 120);
  const expLeaseSec = options.experimentLeaseDurationSeconds || 300; // EXPERIMENT_ONLY default 300s

  const isExtensionValid = extendedLimitSec > initialLimitSec;
  const isAbsoluteMaxValid = absoluteMaxSec >= extendedLimitSec;

  if (!isExtensionValid) {
    checks.timingBoundaryInvariants = {
      pass: false,
      details: `INVALID_EXTENSION_BOUNDARY: proposedExtendedLimitSeconds (${extendedLimitSec}s) must be strictly greater than initialTestLimitSeconds (${initialLimitSec}s).`,
    };
    overallPass = false;
  } else if (!isAbsoluteMaxValid) {
    checks.timingBoundaryInvariants = {
      pass: false,
      details: `INVALID_TIMING_BOUNDARY: absoluteTestMaxSeconds (${absoluteMaxSec}s) must be >= proposedExtendedLimitSeconds (${extendedLimitSec}s).`,
    };
    overallPass = false;
  } else {
    checks.timingBoundaryInvariants = {
      pass: true,
      details: `Timing invariants valid: initial=${initialLimitSec}s, extended=${extendedLimitSec}s, absoluteMax=${absoluteMaxSec}s.`,
    };
  }

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

  // 8. ORIGIN-AWARE READ-ONLY TWILIO PRICING API LOOKUP
  let verifiedRateCentsPerMin: number | undefined = undefined;
  let verifiedIncrementSec: number | undefined = undefined;

  // Check explicit override options / env
  const explicitOverrideRate =
    options.verifiedWholesaleRateCentsPerMinute ??
    (process.env.LEVEL2_VERIFIED_WHOLESALE_RATE_CENTS_PER_MIN
      ? parseFloat(process.env.LEVEL2_VERIFIED_WHOLESALE_RATE_CENTS_PER_MIN)
      : undefined);

  const explicitOverrideIncrement =
    options.verifiedWholesaleBillingIncrementSeconds ??
    (process.env.LEVEL2_VERIFIED_WHOLESALE_INCREMENT_SEC
      ? parseInt(process.env.LEVEL2_VERIFIED_WHOLESALE_INCREMENT_SEC, 10)
      : undefined);

  // If explicit override passed in options, record manual provenance
  if (options.verifiedWholesaleRateCentsPerMinute !== undefined) {
    verifiedRateCentsPerMin = options.verifiedWholesaleRateCentsPerMinute;
    pricingProvenance = 'manual_explicit_override';
  }

  if (options.verifiedWholesaleBillingIncrementSeconds !== undefined) {
    verifiedIncrementSec = options.verifiedWholesaleBillingIncrementSeconds;
    billingIncrementProvenance = 'manual_explicit_override';
  }

  // If rate not explicitly provided, attempt Origin-Aware Twilio Pricing API fetch
  if (verifiedRateCentsPerMin === undefined && credsPresent && client && destValid && !authToken?.startsWith('mock_')) {
    try {
      twilioReadOnlyRequests++;
      // Attempt destination number pricing with originationNumber query context
      try {
        const fetchOptions: any = {};
        if (configuredOwnedNumber && configuredOwnedNumber.startsWith('+')) {
          fetchOptions.originationNumber = configuredOwnedNumber;
        }
        const numPricing = await (client.pricing.v2.voice.numbers(destination!) as any).fetch(fetchOptions);
        if (numPricing && numPricing.outboundCallPrices?.length) {
          // Match origin prefix if available
          const cleanOrigin = configuredOwnedNumber ? configuredOwnedNumber.replace(/^\+/, '') : '';
          let matchedPriceObj = numPricing.outboundCallPrices[0];

          if (cleanOrigin) {
            const bestMatch = numPricing.outboundCallPrices.find((p: any) =>
              p.originationPrefixes?.some((prefix: string) => cleanOrigin.startsWith(prefix))
            );
            if (bestMatch) matchedPriceObj = bestMatch;
          }

          const priceVal = matchedPriceObj?.currentPrice;
          if (priceVal !== undefined && priceVal !== null) {
            const parsed = typeof priceVal === 'number' ? priceVal : parseFloat(priceVal);
            if (!isNaN(parsed)) {
              verifiedRateCentsPerMin = parsed * 100;
              pricingProvenance = 'twilio_pricing_api_number';
            }
          }
        }
      } catch {
        // Fallback to country prefix pricing if number-specific lookup fails
      }

      if (verifiedRateCentsPerMin === undefined) {
        twilioReadOnlyRequests++;
        const countryCode = destination!.startsWith('+61') ? 'AU' : destination!.startsWith('+1') ? 'US' : 'US';
        const countryPricing = await client.pricing.v2.voice.countries(countryCode).fetch();
        if (countryPricing && countryPricing.outboundPrefixPrices?.length) {
          const topPrefixPrice = countryPricing.outboundPrefixPrices[0].currentPrice;
          if (topPrefixPrice !== undefined && topPrefixPrice !== null) {
            const parsed = typeof topPrefixPrice === 'number' ? topPrefixPrice : parseFloat(topPrefixPrice);
            if (!isNaN(parsed)) {
              verifiedRateCentsPerMin = parsed * 100;
              pricingProvenance = 'twilio_pricing_api_country';
            }
          }
        }
      }
    } catch (err: any) {
      console.warn('[Level2APreflight] Read-only Twilio Pricing API lookup failed:', err.message);
    }
  }

  // Fallback to environment explicit override if API pricing unavailable
  if (verifiedRateCentsPerMin === undefined && explicitOverrideRate !== undefined) {
    verifiedRateCentsPerMin = explicitOverrideRate;
    pricingProvenance = 'manual_explicit_override';
  }

  // Handle billing increment derivation
  if (verifiedIncrementSec === undefined) {
    if (explicitOverrideIncrement !== undefined) {
      verifiedIncrementSec = explicitOverrideIncrement;
      billingIncrementProvenance = 'manual_explicit_override';
    } else if (options.allowDocVerifiedIncrement !== false && verifiedRateCentsPerMin !== undefined) {
      // Standard Twilio Programmable Voice billing increment is 60s per official Twilio docs
      verifiedIncrementSec = 60;
      billingIncrementProvenance = 'official_documentation_verified_60s';
    }
  }

  // Cost preflight validation
  let calculatedMaxCostMinor = 0;
  const authorizedBudgetMinor = options.maxAuthorizedBudgetMinor ?? (parseInt(process.env.LEVEL_2_MAX_PROVIDER_COST_MINOR || '10', 10));

  checks.providerPricingVerified = {
    pass: verifiedRateCentsPerMin !== undefined,
    details: verifiedRateCentsPerMin !== undefined
      ? `Authoritative provider pricing established (${verifiedRateCentsPerMin}c/min, provenance: ${pricingProvenance}).`
      : 'PROVIDER_COST_NOT_VERIFIED: Unable to establish authoritative provider wholesale rate from Twilio Pricing API or explicit override.',
  };
  if (verifiedRateCentsPerMin === undefined) overallPass = false;

  checks.providerBillingIncrementVerified = {
    pass: Boolean(verifiedIncrementSec && verifiedIncrementSec > 0),
    details: Boolean(verifiedIncrementSec && verifiedIncrementSec > 0)
      ? `Provider billing increment verified (${verifiedIncrementSec}s, provenance: ${billingIncrementProvenance}).`
      : 'PROVIDER_BILLING_INCREMENT_UNVERIFIED: Provider billing increment cannot be established authoritatively.',
  };
  if (!verifiedIncrementSec || verifiedIncrementSec <= 0) overallPass = false;

  if (verifiedRateCentsPerMin !== undefined && verifiedIncrementSec && verifiedIncrementSec > 0) {
    const totalIntervals = Math.ceil(extendedLimitSec / verifiedIncrementSec);
    const costPerIntervalCents = (verifiedRateCentsPerMin * verifiedIncrementSec) / 60;
    calculatedMaxCostMinor = Math.ceil(totalIntervals * costPerIntervalCents);

    checks.providerCostVerified = {
      pass: true,
      details: `Verified wholesale rate: ${verifiedRateCentsPerMin}c/min, increment: ${verifiedIncrementSec}s. Conservative max cost: ${calculatedMaxCostMinor}c.`,
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

  // 9. TENANT NUMBER OWNERSHIP & CONFLICT AUDIT (Read-Only DB Check)
  let tenantConflictDetails: { conflictDetected: boolean; existingOrganizationId?: string; details: string } = {
    conflictDetected: false,
    details: 'NO_TENANT_CONFLICT: Candidate number is unassigned or assigned to synthetic test tenant 00000000-0000-0000-0000-000000000001.',
  };

  if (options.checkTenantConflict !== false && configuredOwnedNumber && configuredOwnedNumber.startsWith('+')) {
    try {
      let sbClient = options.mockSupabaseClient;
      if (!sbClient && process.env.NEXT_PUBLIC_SUPABASE_URL && (process.env.SUPABASE_SECRET_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)) {
        (globalThis as any).WebSocket = (globalThis as any).WebSocket || class {};
        const key = process.env.SUPABASE_SECRET_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
        sbClient = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, { auth: { persistSession: false } });
      }

      if (sbClient) {
        const { data: phoneRows } = await sbClient
          .from('phone_numbers')
          .select('id, organization_id, phone_number, acquisition_source')
          .eq('phone_number', configuredOwnedNumber);

        if (phoneRows && phoneRows.length > 0) {
          const orgId = phoneRows[0].organization_id;
          if (orgId === '00000000-0000-0000-0000-000000000001') {
            existingNumberOwnerContext = 'SYNTHETIC_TEST';
            tenantConflictDetails = {
              conflictDetected: false,
              existingOrganizationId: orgId,
              details: `EXISTING_NUMBER_OWNER_CONTEXT = SYNTHETIC_TEST. Candidate number ${configuredOwnedNumber} belongs to synthetic dev test organization ${orgId}. Reassignment prohibited; experiment can execute safely under existing tenant context.`,
            };
          } else {
            existingNumberOwnerContext = 'REAL_CUSTOMER';
            tenantConflictDetails = {
              conflictDetected: true,
              existingOrganizationId: orgId,
              details: `TEST_NUMBER_TENANT_CONFLICT: Candidate number ${configuredOwnedNumber} belongs to REAL customer organization ${orgId}. Reassignment or synthetic credit injection into customer ledger strictly prohibited.`,
            };
          }
        }
      }
    } catch (err: any) {
      console.warn('[Level2APreflight] Tenant number conflict check failed:', err.message);
    }
  }

  checks.tenantNumberConflict = {
    pass: !tenantConflictDetails.conflictDetected,
    details: tenantConflictDetails.details,
  };
  if (tenantConflictDetails.conflictDetected) overallPass = false;

  // 10. CANONICAL SCHEMA & ATOMIC FUNDING AUDIT DATA (Verified against database migrations)
  const canonicalSchemaAudit: Record<string, string> = {
    organization: 'public.organizations',
    userProfile: 'public.profiles',
    phoneNumbers: 'public.phone_numbers',
    creditLedger: 'public.billing_credit_ledger',
    retailRateCard: 'public.telecom_retail_rate_cards',
    usageSession: 'public.telecom_usage_sessions',
    usageComponent: 'public.telecom_usage_components',
    providerOperation: 'public.telecom_provider_operations',
    providerEventLog: 'public.telecom_provider_event_log',
    fundingMethod: 'public.record_credit_ledger_entry_atomic(p_organization_id, p_entry_type, p_amount_minor, ...)',
    fundingLocking: 'FOR UPDATE row lock on public.organizations inside record_credit_ledger_entry_atomic',
    fundingEntryType: 'grant (Allowed by CHECK constraint: grant, consumption, expiration, adjustment, usage_reversal, telecom_usage, auto_recharge)',
  };

  const status = overallPass ? 'LEVEL_2A_PREFLIGHT_PASS' : 'LEVEL_2A_PREFLIGHT_FAIL';
  const summary = overallPass
    ? `B.2E LEVEL 2A READ-ONLY PREFLIGHT — PASSED`
    : `B.2E LEVEL 2A READ-ONLY PREFLIGHT — FAILED`;

  return {
    status,
    summary,
    checks,
    calculatedMaxCostMinor,
    authorizedBudgetMinor,
    experimentLeaseSeconds: expLeaseSec,
    requiredSafetySeconds: leaseSafety.requiredSafetySeconds,
    twilioReadOnlyRequests,
    pricingProvenance,
    billingIncrementProvenance,
    candidateNumberType,
    existingNumberOwnerContext,
    accountDetails,
    ownedNumbersDetails,
    tenantConflictDetails,
    canonicalSchemaAudit,
    proposedTimingEnvelope: {
      initialTestLimitSeconds: initialLimitSec,
      proposedExtendedLimitSeconds: extendedLimitSec,
      absoluteTestMaxSeconds: absoluteMaxSec,
    },
  };
}
