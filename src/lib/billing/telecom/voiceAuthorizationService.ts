import { SupabaseClient } from '@supabase/supabase-js';
import { TelecomRatingService } from './telecomRatingService';
import { ExposurePolicy, ExposurePolicyConfig, CalculatedExposure, ExposurePolicyError } from './exposurePolicy';
import { TelecomDomainService } from './telecomDomainService';
import { TelecomWalletService } from '../telecomWalletService';
import { TelecomWholesaleService } from './telecomWholesaleService';
import { CustomerTelecomSessionDTO, toCustomerTelecomSessionDTO, RateResolutionResult } from './types';

export interface AuthorizeOutboundVoiceParams {
  organizationId: string;
  dbCallId: string;
  userId?: string | null;
  fromNumber: string;
  toNumber: string;
  currency?: string;
  policyConfigOverrides?: Partial<ExposurePolicyConfig>;
  providerAccountId?: string;
  forceDynamicPath?: boolean;
}

export interface OutboundVoiceAuthorizationResult {
  authorized: boolean;
  authorizationId?: string;
  reservationId?: string;
  reservedAmountMinor?: number;
  authorizedSeconds?: number;
  providerTimeLimit?: number;
  timeLimitSeconds?: number;
  reservationDurationSeconds?: number;
  failureReason?: string;
  customerMessage?: string;
  sessionId?: string;
  internalUsageId?: string;
  calculatedExposure?: CalculatedExposure;
  matchedRate?: RateResolutionResult;
  isShadowMode?: boolean;
}

export class VoiceAuthorizationService {
  /**
   * Validates whether a given providerTimeLimit satisfies all fail-closed boundary constraints:
   * present, numeric, finite, non-NaN, positive integer seconds.
   */
  public static isValidProviderTimeLimit(val: unknown): val is number {
    return (
      val !== undefined &&
      val !== null &&
      typeof val === 'number' &&
      Number.isFinite(val) &&
      !Number.isNaN(val) &&
      Number.isInteger(val) &&
      val > 0
    );
  }

  /**
   * Calculates the exact maximum provider duration in seconds funded by the reserved amount.
   * Guaranteed invariant: calculateRetailChargeMinor(rateCard, durationSeconds) <= reservedAmountMinor.
   * Uses conservative floor rounding down to billing increments so provider exposure cannot exceed reservation.
   */
  public static calculateMaxFundedSecondsFromReservation(
    rateCard: any,
    reservedAmountMinor: number
  ): number {
    if (!rateCard || !rateCard.retailRateMicro || rateCard.retailRateMicro <= 0 || reservedAmountMinor <= 0) {
      return 0;
    }

    const increment = Math.max(1, rateCard.billingIncrementSeconds || 60);
    const minUnits = Math.max(1, rateCard.minChargeableUnits || 1);
    const minDuration = minUnits * increment;

    // Minimum charge check
    const minCostMinor = TelecomWalletService.calculateRetailChargeMinor({
      retailRateMicro: rateCard.retailRateMicro,
      durationSeconds: minDuration,
      billingIncrementSeconds: increment,
      minChargeableUnits: minUnits,
      unitType: rateCard.unitType || 'minute',
    });

    if (reservedAmountMinor < minCostMinor) {
      return 0;
    }

    // Binary search for maximum billable increments fully covered by reservedAmountMinor
    let lowIncrements = minUnits;
    let highIncrements = Math.max(
      minUnits,
      Math.ceil((reservedAmountMinor * 10000 * 60) / (rateCard.retailRateMicro * increment)) + 2
    );
    let bestIncrements = lowIncrements;

    while (lowIncrements <= highIncrements) {
      const midIncrements = Math.floor((lowIncrements + highIncrements) / 2);
      const testSeconds = midIncrements * increment;
      const testCostMinor = TelecomWalletService.calculateRetailChargeMinor({
        retailRateMicro: rateCard.retailRateMicro,
        durationSeconds: testSeconds,
        billingIncrementSeconds: increment,
        minChargeableUnits: minUnits,
        unitType: rateCard.unitType || 'minute',
      });

      if (testCostMinor <= reservedAmountMinor) {
        bestIncrements = midIncrements;
        lowIncrements = midIncrements + 1;
      } else {
        highIncrements = midIncrements - 1;
      }
    }

    return bestIncrements * increment;
  }

  /**
   * Authoritatively evaluates and executes pre-exposure wallet authorization for outbound voice.
   * Executed strictly server-side at POST /api/twilio/voice/outbound before returning TwiML <Dial>.
   */
  public static async authorizeOutboundVoice(
    client: SupabaseClient,
    params: AuthorizeOutboundVoiceParams
  ): Promise<OutboundVoiceAuthorizationResult> {
    const {
      organizationId,
      dbCallId,
      userId = null,
      fromNumber,
      toNumber,
      currency = 'USD',
      policyConfigOverrides,
      providerAccountId = 'default',
      forceDynamicPath = false,
    } = params;

    if (!organizationId || !dbCallId || !toNumber) {
      return {
        authorized: false,
        failureReason: 'INVALID_PARAMETERS',
        customerMessage: 'We are unable to connect your call at this time. Please check call details or contact support.',
      };
    }

    // Offboarding Telecom Eligibility Interlock
    const { TelecomEligibilityService } = await import('@/lib/telephony/lifecycle/telecomEligibilityService');
    const eligibility = await TelecomEligibilityService.canUseTelecom(
      {
        organizationId,
        phoneNumberE164: fromNumber,
      },
      client
    );

    if (!eligibility.allowed) {
      return {
        authorized: false,
        failureReason: 'SERVICE_SUSPENDED',
        customerMessage: eligibility.reason,
      };
    }

    // Destination Risk & Emergency Policy Check
    const { DestinationRiskService } = await import('@/lib/telecom/fraud/destinationRiskService');
    const { TelecomSecurityAuditService } = await import('@/lib/telecom/fraud/telecomSecurityAuditService');

    const orgPolicy = await DestinationRiskService.getOrgGeographicPolicy(client, organizationId);
    const riskEval = DestinationRiskService.evaluateDestination(toNumber, orgPolicy);
    if (riskEval.classification === 'BLOCKED' || riskEval.isEmergency) {
      await TelecomSecurityAuditService.logSecurityEvent(client, {
        organizationId,
        userId,
        phoneNumber: fromNumber,
        destination: toNumber,
        riskRule: riskEval.riskRule || (riskEval.isEmergency ? 'EMERGENCY_DESTINATION_GATE' : 'DESTINATION_RISK_BLOCKED'),
        operation: 'voice_dial',
        decision: 'blocked',
        reason: riskEval.reason,
        metadata: {
          countryCode: riskEval.countryCode,
        },
      });

      return {
        authorized: false,
        failureReason: riskEval.isEmergency ? 'EMERGENCY_SERVICES_NOT_SUPPORTED' : 'DESTINATION_RISK_BLOCKED',
        customerMessage: riskEval.reason,
      };
    }

    // Phase 24B: Authoritative Local Control Plane & Circuit Breaker Check
    const { TelecomControlPlaneService } = await import('@/lib/telecom/controlPlane');
    const controlEval = await TelecomControlPlaneService.evaluate(
      {
        organizationId,
        operation: 'OUTBOUND_VOICE',
        userId,
        phoneNumber: fromNumber,
        destination: toNumber,
        context: { dbCallId },
      },
      client
    );
    if (!controlEval.allowed) {
      return {
        authorized: false,
        failureReason: controlEval.reasonCode,
        customerMessage: controlEval.reason,
      };
    }

    // Layered Telecom Suspension Kill Switches
    const { TelecomSuspensionService } = await import('@/lib/telecom/fraud/telecomSuspensionService');
    const suspension = await TelecomSuspensionService.checkSuspension(client, {
      organizationId,
      userId,
      phoneNumber: fromNumber,
    });
    if (suspension.isSuspended) {
      return {
        authorized: false,
        failureReason: `TELECOM_SUSPENSION_${suspension.level}`,
        customerMessage: suspension.reason || 'Telecom access suspended.',
      };
    }

    // 1. Resolve exposure policy & enforcement mode
    let policyConfig: ExposurePolicyConfig;
    try {
      policyConfig = ExposurePolicy.getConfig(policyConfigOverrides);
      ExposurePolicy.validateConfig(policyConfig);
    } catch (err: any) {
      if (err instanceof ExposurePolicyError) {
        console.error('[VoiceAuthorizationService] Exposure policy error:', err.message);
        return {
          authorized: false,
          failureReason: err.code || 'INVALID_EXPOSURE_POLICY_CONFIG',
          customerMessage: 'We are unable to connect your call at this time. Please contact support.',
        };
      }
      throw err;
    }

    const { enforcementMode } = policyConfig;

    // Disabled mode: legacy development behavior (allow call without credit checks)
    if (enforcementMode === 'disabled') {
      const initialSec = policyConfig.initialExposureSeconds || 300;
      return {
        authorized: true,
        authorizationId: `disabled:${dbCallId}`,
        authorizedSeconds: initialSec,
        providerTimeLimit: initialSec,
        timeLimitSeconds: initialSec,
        reservationDurationSeconds: initialSec,
        isShadowMode: false,
      };
    }

    // Concurrency / Risk Limits Check (Organization-level technical risk control)
    if (enforcementMode === 'enforce') {
      const concurrencyCheck = await this.checkConcurrentCallLimit(client, organizationId);
      if (!concurrencyCheck.allowed) {
        console.warn(`[VoiceAuthorizationService] Org ${organizationId} exceeded concurrent call limit (${concurrencyCheck.currentActive}/${concurrencyCheck.limit})`);
        return {
          authorized: false,
          failureReason: 'CONCURRENT_CALL_LIMIT_EXCEEDED',
          customerMessage: 'Your organization has reached its concurrent active call limit. Please wait for an existing call to complete or contact support.',
        };
      }
    }

    // Phase 21A.1: Authoritatively resolve Provider Account Context before rating or exposure
    let resolvedProvider = 'twilio';
    let resolvedProviderAccountId = providerAccountId;
    try {
      const { ProviderAccountResolver } = await import('@/lib/telecom/provider/providerAccountResolver');
      const providerResolution = await ProviderAccountResolver.resolveAccount({
        organizationId,
        service: 'VOICE',
      }, client);

      if (!providerResolution.success || !providerResolution.context) {
        return {
          authorized: false,
          failureReason: providerResolution.errorCode || 'UNKNOWN_OR_INACTIVE_PROVIDER',
          customerMessage: providerResolution.errorMessage || 'No authorized voice provider account available for your organization.',
        };
      }

      resolvedProvider = providerResolution.context.provider.toLowerCase();
      resolvedProviderAccountId = providerResolution.context.providerAccountId;
    } catch (provErr: any) {
      console.warn('[VoiceAuthorizationService] Provider resolution exception:', provErr.message || provErr);
      return {
        authorized: false,
        failureReason: 'PROVIDER_RESOLUTION_FAILED',
        customerMessage: 'We are unable to resolve your telecom provider context. Please contact support.',
      };
    }

    // 2. Authoritatively resolve retail rate for destination (dynamic or legacy based on feature flag / parameter)
    let matchedRate: RateResolutionResult;
    try {
      matchedRate = await TelecomRatingService.resolveRetailRate(client, {
        organizationId,
        provider: resolvedProvider,
        providerAccountId: resolvedProviderAccountId,
        serviceType: 'voice_outbound',
        direction: 'outbound',
        destinationPhoneNumber: toNumber,
        originationPhoneNumber: fromNumber,
        currency,
        forceDynamicPath,
      });
    } catch (rateErr: any) {
      console.warn('[VoiceAuthorizationService] Retail rate resolution failed:', rateErr.message);
      return {
        authorized: false,
        failureReason: 'RATE_CARD_NOT_FOUND',
        customerMessage: 'We are unable to connect your call at this time. Calling rate is unavailable for this destination.',
      };
    }

    // Rate Safety Invariant: establish trustworthy positive rate card or fail closed
    if (!matchedRate || !matchedRate.matchedRateCard || !matchedRate.retailRateMicro || matchedRate.retailRateMicro <= 0) {
      return {
        authorized: false,
        failureReason: 'RATE_CARD_NOT_FOUND',
        customerMessage: 'We are unable to connect your call at this time. Calling rate is unavailable for this destination.',
      };
    }

    // 3. Compute rate-aware initial exposure parameters
    const exposure = ExposurePolicy.calculateInitialExposure(matchedRate.matchedRateCard, policyConfigOverrides);

    const sessionId = dbCallId;
    const internalUsageId = `call:outbound:${dbCallId}`;
    const componentId = `comp:pstn_outbound:${dbCallId}`;

    // Shadow log mode: calculate rates & exposure for observability, but place ZERO wallet reservations or ledger movements
    if (enforcementMode === 'shadow_log') {
      console.log('[Telecom Exposure Shadow Log]', {
        organizationId,
        dbCallId,
        destination: toNumber,
        matchedPrefix: matchedRate.matchedPrefix,
        rateMicro: matchedRate.retailRateMicro,
        wholesaleRateMicro: matchedRate.matchedRateCard.wholesaleCostMicro,
        initialDurationSeconds: exposure.initialDurationSeconds,
        requiredFundedMinor: exposure.requiredFundedMinor,
        enforcementMode: 'shadow_log',
      });

      return {
        authorized: true,
        authorizationId: `shadow:${dbCallId}`,
        authorizedSeconds: exposure.initialDurationSeconds,
        providerTimeLimit: exposure.initialDurationSeconds,
        timeLimitSeconds: exposure.initialDurationSeconds,
        reservationDurationSeconds: exposure.initialDurationSeconds,
        sessionId,
        internalUsageId,
        calculatedExposure: exposure,
        matchedRate,
        isShadowMode: true,
      };
    }

    // 4. ENFORCE MODE: Create durable session & component first, then place atomic wallet reservation hold
    try {
      // Step A: Create or fetch durable telecom usage session
      try {
        await TelecomDomainService.createSession(client, {
          sessionId,
          organizationId,
          createdByUserId: userId,
          sessionType: 'outbound_call',
          direction: 'outbound',
          currency,
          metadata: {
            from_number: fromNumber,
            to_number: toNumber,
          },
        });
      } catch (sessErr: any) {
        if (!sessErr.message?.includes('23505') && !sessErr.message?.includes('duplicate key')) {
          console.error('[VoiceAuthorizationService] Session creation error:', sessErr.message);
          return {
            authorized: false,
            failureReason: 'SESSION_CREATION_FAILED',
            customerMessage: 'We are unable to connect your call at this time. Please try again.',
          };
        }
      }

      // Step B: Create or fetch durable PSTN component
      try {
        await TelecomDomainService.createComponent(client, {
          componentId,
          sessionId,
          organizationId,
          internalUsageId,
          legType: 'pstn_outbound',
          sequenceNumber: 1,
          durationSeconds: 0,
          retailChargeMinor: 0,
          metadata: {
            to_number: toNumber,
          },
        });
      } catch (compErr: any) {
        if (!compErr.message?.includes('23505') && !compErr.message?.includes('duplicate key')) {
          console.error('[VoiceAuthorizationService] Component creation error:', compErr.message);
          return {
            authorized: false,
            failureReason: 'COMPONENT_CREATION_FAILED',
            customerMessage: 'We are unable to connect your call at this time. Please try again.',
          };
        }
      }

      // Step C: Place atomic wallet pre-exposure reservation hold with complete immutable rate snapshot
      const rateSnapshotPayload = {
        rateMicro: matchedRate.retailRateMicro,
        retailRateMicro: matchedRate.retailRateMicro,
        wholesaleRateMicro: matchedRate.matchedRateCard.wholesaleCostMicro || 0,
        billingIncrementSeconds: matchedRate.matchedRateCard.billingIncrementSeconds || 60,
        minChargeableUnits: matchedRate.matchedRateCard.minChargeableUnits || 1,
        unitType: matchedRate.matchedRateCard.unitType || 'minute',
        currency: matchedRate.currency || 'USD',
        prefix: matchedRate.matchedPrefix,
        source: matchedRate.resolutionSource,
        pricingPolicyId: matchedRate.matchedRateCard.metadata?.pricing_policy_id,
        pricingMode: matchedRate.matchedRateCard.metadata?.pricing_mode,
        markupBasisPoints: matchedRate.matchedRateCard.metadata?.markup_basis_points || 2500,
        providerKey: matchedRate.matchedRateCard.metadata?.provider_key || 'twilio',
        providerAccountId: matchedRate.matchedRateCard.metadata?.provider_account_id || providerAccountId,
        freshnessState: matchedRate.matchedRateCard.metadata?.freshness_state,
        pricingFingerprint: matchedRate.matchedRateCard.metadata?.pricing_fingerprint,
        authorizationTimestamp: matchedRate.matchedRateCard.metadata?.authorization_timestamp || new Date().toISOString(),
      };

      const reservationRes = await TelecomWalletService.reserveUsage(client, {
        organizationId,
        internalUsageId,
        serviceType: 'voice_outbound',
        direction: 'outbound',
        amountReservedMinor: exposure.requiredFundedMinor,
        idempotencyKey: `reserve:outbound:${dbCallId}`,
        expiresInSeconds: 1800,
        currency,
        provider: 'twilio',
        rateCardId: matchedRate.matchedRateCard.id,
        rateSnapshot: rateSnapshotPayload,
        metadata: {
          sessionId,
          componentId,
        },
      });

      if (!reservationRes.success) {
        console.warn('[VoiceAuthorizationService] Wallet reservation returned unsuccessful state.');
        return {
          authorized: false,
          failureReason: 'RESERVATION_FAILED',
          customerMessage: 'Your account has insufficient Credits to place this call. Please add Credits to continue.',
        };
      }

      // Record confidential wholesale economics snapshot
      await TelecomWholesaleService.recordWholesaleSnapshot(client, {
        organizationId,
        reservationId: reservationRes.reservationId,
        internalUsageId,
        providerKey: matchedRate.matchedRateCard.metadata?.provider_key || 'twilio',
        serviceType: 'voice_outbound',
        direction: 'outbound',
        currency,
        estimatedWholesaleRateMicro: matchedRate.matchedRateCard.wholesaleCostMicro || 0,
        estimatedWholesaleCostMinor: TelecomWalletService.calculateRetailChargeMinor({
          retailRateMicro: matchedRate.matchedRateCard.wholesaleCostMicro || 0,
          durationSeconds: exposure.initialDurationSeconds,
          billingIncrementSeconds: matchedRate.matchedRateCard.billingIncrementSeconds || 60,
          minChargeableUnits: matchedRate.matchedRateCard.minChargeableUnits || 1,
          unitType: matchedRate.matchedRateCard.unitType || 'minute',
        }),
        metadata: {
          pricing_policy_id: matchedRate.matchedRateCard.metadata?.pricing_policy_id,
          pricing_mode: matchedRate.matchedRateCard.metadata?.pricing_mode,
        },
      });

      // Compute safe rate-aware & risk-aware provider <Dial> timeLimit ceiling:
      // Prevents high-cost / elevated-risk destinations from receiving standard 3,600s ceilings.
      const riskAwareMaxCeilingSeconds = DestinationRiskService.calculateRiskAwareProviderCeiling(
        matchedRate.retailRateMicro,
        riskEval.classification,
        exposure.maxProviderExposureSeconds
      );

      // LOCKED INVARIANT: Provider timeLimit MUST be bounded strictly by the funds actually reserved!
      // Derive maximum duration from the monetary reservation hold, NOT the unreserved wallet balance.
      const maxFundedSeconds = this.calculateMaxFundedSecondsFromReservation(
        matchedRate.matchedRateCard,
        reservationRes.amountReservedMinor
      );

      // Provider-authorized duration must never exceed the exposure atomically reserved for this call
      const authorizedSeconds = Math.min(exposure.initialDurationSeconds, maxFundedSeconds);
      const providerTimeLimit = Math.min(authorizedSeconds, riskAwareMaxCeilingSeconds);

      if (!this.isValidProviderTimeLimit(providerTimeLimit)) {
        console.warn(`[VoiceAuthorizationService] Provider timeLimit invalid or non-positive (${providerTimeLimit}) after reservation. Compensating hold.`);
        await this.compensatePreDispatchFailure(
          client,
          organizationId,
          internalUsageId,
          dbCallId
        );
        return {
          authorized: false,
          failureReason: 'INSUFFICIENT_RESERVATION_DURATION',
          customerMessage: 'Your account balance is insufficient to authorize a call to this destination.',
        };
      }

      return {
        authorized: true,
        authorizationId: reservationRes.reservationId,
        reservationId: reservationRes.reservationId,
        reservedAmountMinor: reservationRes.amountReservedMinor,
        authorizedSeconds,
        providerTimeLimit,
        timeLimitSeconds: providerTimeLimit,
        reservationDurationSeconds: authorizedSeconds,
        sessionId,
        internalUsageId,
        calculatedExposure: exposure,
        matchedRate,
        isShadowMode: false,
      };
    } catch (err: any) {
      console.error('[VoiceAuthorizationService] Exception during authorization:', err.message || err);

      const isInsufficient = err.message?.includes('INSUFFICIENT_AVAILABLE_BALANCE');
      const isRestricted = err.message?.includes('ORGANIZATION_BILLING_RESTRICTED');
      const isConcurrency = err.message?.includes('CONCURRENT_CALL_LIMIT_EXCEEDED');

      const failureReason = isConcurrency
        ? 'CONCURRENT_CALL_LIMIT_EXCEEDED'
        : isInsufficient
        ? 'INSUFFICIENT_AVAILABLE_BALANCE'
        : isRestricted
        ? 'ORGANIZATION_BILLING_RESTRICTED'
        : 'AUTHORIZATION_SYSTEM_ERROR';

      const customerMessage = isConcurrency
        ? 'Your organization has reached its concurrent active call limit. Please wait for an existing call to complete or contact support.'
        : isInsufficient
        ? 'Your account has insufficient Credits to place this call. Please add Credits to continue.'
        : isRestricted
        ? 'Your organization billing is currently restricted from telecom usage.'
        : 'We are unable to connect your call at this time. Please try again later.';

      return {
        authorized: false,
        failureReason,
        customerMessage,
      };
    }
  }

  public static async compensatePreDispatchFailure(
    client: SupabaseClient,
    organizationId: string,
    internalUsageId: string,
    idempotencyKey: string
  ): Promise<boolean> {
    try {
      console.log(`[VoiceAuthorizationService] Executing pre-dispatch failure compensation for ${internalUsageId}`);
      const releaseRes = await TelecomWalletService.releaseUsage(client, {
        organizationId,
        internalUsageId,
        reason: 'authorization_dispatch_failed',
        idempotencyKey: `release:compensation:${idempotencyKey}`,
      });
      return releaseRes.success;
    } catch (releaseErr: any) {
      console.error('[VoiceAuthorizationService] Compensation release failed. Marking reconciliation_required:', releaseErr.message);
      try {
        await client
          .from('telecom_usage_sessions')
          .update({ reconciliation_status: 'manual_review', updated_at: new Date().toISOString() })
          .eq('organization_id', organizationId)
          .eq('session_id', internalUsageId.replace('call:outbound:', ''));
      } catch (markErr) {
        console.error('[VoiceAuthorizationService] Error marking manual review:', markErr);
      }
      return false;
    }
  }

  /**
   * Evaluates organization-level concurrent active voice call limits (Technical Risk Control).
   * Note: This is an infrastructure safety risk-control threshold, NOT a commercial subscription entitlement.
   * Administrative and owner roles CANNOT bypass this safety limit.
   */
  public static async checkConcurrentCallLimit(
    client: SupabaseClient,
    organizationId: string
  ): Promise<{ allowed: boolean; currentActive: number; limit: number }> {
    const DEFAULT_MAX_CONCURRENT_CALLS = parseInt(process.env.TELECOM_MAX_CONCURRENT_CALLS_PER_ORG || '5', 10);

    let configuredLimit = DEFAULT_MAX_CONCURRENT_CALLS;
    try {
      const { data: controls } = await client
        .from('organization_billing_controls')
        .select('max_concurrent_voice_calls')
        .eq('organization_id', organizationId)
        .maybeSingle();

      if (controls && typeof controls.max_concurrent_voice_calls === 'number' && controls.max_concurrent_voice_calls > 0) {
        configuredLimit = controls.max_concurrent_voice_calls;
      }
    } catch {
      // Fall back to default
    }

    try {
      const { count, error } = await client
        .from('telecom_usage_reservations')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', organizationId)
        .eq('status', 'active')
        .in('service_type', ['voice_outbound', 'voice_inbound']);

      if (!error && typeof count === 'number') {
        const currentActive = count;
        if (currentActive >= configuredLimit) {
          return { allowed: false, currentActive, limit: configuredLimit };
        }
        return { allowed: true, currentActive, limit: configuredLimit };
      }
    } catch (countErr: any) {
      console.warn('[VoiceAuthorizationService] Error counting active voice reservations:', countErr.message);
    }

    return { allowed: true, currentActive: 0, limit: configuredLimit };
  }
}
