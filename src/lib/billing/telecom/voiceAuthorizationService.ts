import { SupabaseClient } from '@supabase/supabase-js';
import { TelecomRatingService } from './telecomRatingService';
import { ExposurePolicy, ExposurePolicyConfig, CalculatedExposure, ExposurePolicyError } from './exposurePolicy';
import { TelecomDomainService } from './telecomDomainService';
import { TelecomWalletService } from '../telecomWalletService';
import { CustomerTelecomSessionDTO, toCustomerTelecomSessionDTO, RateResolutionResult } from './types';

export interface AuthorizeOutboundVoiceParams {
  organizationId: string;
  dbCallId: string;
  userId?: string | null;
  fromNumber: string;
  toNumber: string;
  currency?: string;
  policyConfigOverrides?: Partial<ExposurePolicyConfig>;
}

export interface OutboundVoiceAuthorizationResult {
  authorized: boolean;
  timeLimitSeconds?: number;
  failureReason?: string;
  customerMessage?: string;
  sessionId?: string;
  internalUsageId?: string;
  calculatedExposure?: CalculatedExposure;
  matchedRate?: RateResolutionResult;
  reservationId?: string;
  isShadowMode?: boolean;
}

export class VoiceAuthorizationService {
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
    } = params;

    if (!organizationId || !dbCallId || !toNumber) {
      return {
        authorized: false,
        failureReason: 'INVALID_PARAMETERS',
        customerMessage: 'We are unable to connect your call at this time. Please check call details or contact support.',
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
      return {
        authorized: true,
        timeLimitSeconds: policyConfig.initialExposureSeconds || 3600,
        isShadowMode: false,
      };
    }

    // 2. Authoritatively resolve retail rate for destination
    let matchedRate: RateResolutionResult;
    try {
      matchedRate = await TelecomRatingService.resolveRetailRate(client, {
        organizationId,
        serviceType: 'voice_outbound',
        direction: 'outbound',
        destinationPhoneNumber: toNumber,
        currency,
      });
    } catch (rateErr: any) {
      console.warn('[VoiceAuthorizationService] Retail rate resolution failed:', rateErr.message);
      return {
        authorized: false,
        failureReason: 'RATE_CARD_NOT_FOUND',
        customerMessage: 'Calling rate is unconfigured for this destination. Please contact support.',
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
        initialDurationSeconds: exposure.initialDurationSeconds,
        requiredFundedMinor: exposure.requiredFundedMinor,
        enforcementMode: 'shadow_log',
      });

      return {
        authorized: true,
        timeLimitSeconds: exposure.initialDurationSeconds,
        sessionId,
        internalUsageId,
        calculatedExposure: exposure,
        matchedRate,
        isShadowMode: true,
      };
    }

    // 4. ENFORCE MODE: Create durable session & component first, then place atomic wallet reservation hold
    let sessionCreated = false;
    let componentCreated = false;

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
        sessionCreated = true;
      } catch (sessErr: any) {
        // If session already exists (e.g. webhook retry), ignore duplicate insert
        if (sessErr.message?.includes('23505') || sessErr.message?.includes('duplicate key')) {
          sessionCreated = true;
        } else {
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
        componentCreated = true;
      } catch (compErr: any) {
        if (compErr.message?.includes('23505') || compErr.message?.includes('duplicate key')) {
          componentCreated = true;
        } else {
          console.error('[VoiceAuthorizationService] Component creation error:', compErr.message);
          return {
            authorized: false,
            failureReason: 'COMPONENT_CREATION_FAILED',
            customerMessage: 'We are unable to connect your call at this time. Please try again.',
          };
        }
      }

      // Step C: Place atomic wallet pre-exposure reservation hold
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
        rateSnapshot: {
          rateMicro: matchedRate.retailRateMicro,
          retailRateMicro: matchedRate.retailRateMicro,
          billingIncrementSeconds: matchedRate.matchedRateCard.billingIncrementSeconds || 60,
          minChargeableUnits: matchedRate.matchedRateCard.minChargeableUnits || 1,
          unitType: matchedRate.matchedRateCard.unitType || 'minute',
          currency: matchedRate.currency || 'USD',
          prefix: matchedRate.matchedPrefix,
          source: matchedRate.resolutionSource,
        },
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

      return {
        authorized: true,
        timeLimitSeconds: exposure.initialDurationSeconds,
        sessionId,
        internalUsageId,
        calculatedExposure: exposure,
        matchedRate,
        reservationId: reservationRes.reservationId,
        isShadowMode: false,
      };
    } catch (err: any) {
      console.error('[VoiceAuthorizationService] Exception during authorization:', err.message || err);

      const isInsufficient = err.message?.includes('INSUFFICIENT_AVAILABLE_BALANCE');
      const isRestricted = err.message?.includes('ORGANIZATION_BILLING_RESTRICTED');

      const failureReason = isInsufficient
        ? 'INSUFFICIENT_AVAILABLE_BALANCE'
        : isRestricted
        ? 'ORGANIZATION_BILLING_RESTRICTED'
        : 'AUTHORIZATION_SYSTEM_ERROR';

      const customerMessage = isInsufficient
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

  /**
   * Safe pre-dispatch failure compensation helper.
   * Only invoked when failure occurs AFTER successful reservation hold AND BEFORE response handoff has started.
   */
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
      // Mark session reconciliation_status = 'manual_review' so recovery workers pick it up
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
}
