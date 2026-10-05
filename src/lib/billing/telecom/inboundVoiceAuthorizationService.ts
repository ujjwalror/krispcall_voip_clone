import { SupabaseClient } from '@supabase/supabase-js';
import { TelecomRatingService } from './telecomRatingService';
import { TelecomWalletService } from '../telecomWalletService';
import { TelecomDomainService } from './telecomDomainService';
import { TelecomWholesaleService } from './telecomWholesaleService';
import { ExposurePolicy } from './exposurePolicy';
import { RateResolutionResult } from './types';

export class InboundVoiceAuthorizationError extends Error {
  public statusCode: number;
  public errorCode?: string;

  constructor(message: string, statusCode: number = 400, errorCode?: string) {
    super(message);
    this.name = 'InboundVoiceAuthorizationError';
    this.statusCode = statusCode;
    this.errorCode = errorCode;
  }
}

export interface InboundVoiceAuthorizationParams {
  callSid: string;
  calledNumber: string;
  callerNumber: string;
  overrideInitialExposureSeconds?: number;
  forceDynamicPath?: boolean;
}

export interface InboundVoiceAuthorizationResult {
  authorized: boolean;
  organizationId: string;
  sessionId: string;
  componentId: string;
  internalUsageId: string;
  reservationId: string;
  amountReservedMinor: number;
  rateSnapshot: RateResolutionResult;
  enforcementMode: 'disabled' | 'shadow_log' | 'enforce';
}

export class InboundVoiceAuthorizationService {
  /**
   * Authorizes an inbound voice call prior to returning TwiML dial / routing instructions.
   * Performs server-authoritative called-number tenant lookup, rate resolution with trusted number_type metadata,
   * bounded initial exposure calculation, and atomic wallet reservation.
   *
   * FAILS CLOSED if:
   * 1. Called number is unconfigured, inactive, or not assigned to an active tenant.
   * 2. No matching inbound retail rate card/cache exists (e.g., India IN empty inbound scope).
   * 3. Wallet available balance is insufficient in enforce mode.
   */
  public static async authorizeInboundCall(
    client: SupabaseClient,
    params: InboundVoiceAuthorizationParams
  ): Promise<InboundVoiceAuthorizationResult> {
    const { callSid, calledNumber, callerNumber, overrideInitialExposureSeconds, forceDynamicPath = false } = params;

    const cleanCallSid = (callSid || '').trim();
    if (!cleanCallSid) {
      throw new InboundVoiceAuthorizationError('Missing required CallSid for inbound authorization', 400, 'INVALID_CALL_SID');
    }

    const cleanCalled = (calledNumber || '').trim();
    if (!cleanCalled) {
      throw new InboundVoiceAuthorizationError('Missing destination called phone number', 400, 'INVALID_CALLED_NUMBER');
    }

    // 1. Resolve tenant-owned active phone number metadata (including trusted stored number type & country)
    const { data: phoneRecord, error: phoneErr } = await client
      .from('phone_numbers')
      .select('id, organization_id, active, type, country_code, capabilities_voice, provider_account_id')
      .eq('phone_number', cleanCalled)
      .eq('active', true)
      .maybeSingle();

    if (phoneErr) {
      throw new InboundVoiceAuthorizationError(`Database error resolving phone number: ${phoneErr.message}`, 500, 'DB_ERROR');
    }

    if (!phoneRecord || !phoneRecord.organization_id) {
      throw new InboundVoiceAuthorizationError(
        `Destination number "${cleanCalled}" is unconfigured or inactive.`,
        400,
        'PHONE_NUMBER_NOT_CONFIGURED'
      );
    }

    // Offboarding Telecom Eligibility Interlock
    const { TelecomEligibilityService } = await import('@/lib/telephony/lifecycle/telecomEligibilityService');
    const eligibility = await TelecomEligibilityService.canUseTelecom({
      organizationId: phoneRecord.organization_id,
      phoneNumberId: phoneRecord.id,
      phoneNumberE164: cleanCalled,
    });

    if (!eligibility.allowed) {
      throw new InboundVoiceAuthorizationError(eligibility.reason, 403, 'SERVICE_SUSPENDED');
    }

    const organizationId = phoneRecord.organization_id;
    const trustedNumberType = phoneRecord.type || null;
    const trustedCountryCode = phoneRecord.country_code || 'US';
    const providerAccountId = phoneRecord.provider_account_id || 'default';

    // Verify voice capability
    if (phoneRecord.capabilities_voice === false) {
      throw new InboundVoiceAuthorizationError(
        `Destination number "${cleanCalled}" does not have voice capability active.`,
        400,
        'VOICE_CAPABILITY_DISABLED'
      );
    }

    // 2. Resolve inbound retail rate card using trusted server-side metadata (never customer/browser input)
    let rateSnapshot: RateResolutionResult;
    try {
      rateSnapshot = await TelecomRatingService.resolveRetailRate(client, {
        organizationId,
        provider: 'twilio',
        providerAccountId,
        serviceType: 'voice_inbound',
        direction: 'inbound',
        destinationPhoneNumber: cleanCalled,
        numberType: trustedNumberType,
        isoCountry: trustedCountryCode,
        currency: 'USD',
        forceDynamicPath,
      });
    } catch (rateErr: any) {
      throw new InboundVoiceAuthorizationError(
        `Inbound rate resolution failed: ${rateErr.message}`,
        400,
        'INBOUND_PRICING_UNAVAILABLE'
      );
    }

    // 3. Calculate initial exposure
    const exposureConfig = ExposurePolicy.getConfig(
      overrideInitialExposureSeconds ? { initialExposureSeconds: overrideInitialExposureSeconds } : undefined
    );
    const initialExposureSeconds = exposureConfig.initialExposureSeconds;
    const enforcementMode = (process.env.TELECOM_PREPAID_ENFORCEMENT_MODE || 'shadow_log').toLowerCase() as any;

    const amountReservedMinor = TelecomWalletService.calculateRetailChargeMinor({
      retailRateMicro: rateSnapshot.retailRateMicro,
      durationSeconds: initialExposureSeconds,
      unitType: rateSnapshot.unitType || 'minute',
      billingIncrementSeconds: rateSnapshot.billingIncrementSeconds || 60,
      minChargeableUnits: rateSnapshot.minChargeableUnits || 1,
    });

    // 4. Construct TEXT identities
    const sessionId = `sess_inbound_${cleanCallSid}`;
    const componentId = `comp_inbound_pstn_${cleanCallSid}`;
    const internalUsageId = `inbound_call_${cleanCallSid}`;
    const idempotencyKey = `idemp_inbound_auth_${cleanCallSid}`;

    let reservationId = '';

    // Complete rate snapshot payload for wallet reservation
    const rateSnapshotPayload = {
      rateMicro: rateSnapshot.retailRateMicro,
      retailRateMicro: rateSnapshot.retailRateMicro,
      wholesaleRateMicro: rateSnapshot.matchedRateCard.wholesaleCostMicro || 0,
      billingIncrementSeconds: rateSnapshot.billingIncrementSeconds || 60,
      minChargeableUnits: rateSnapshot.minChargeableUnits || 1,
      unitType: rateSnapshot.unitType || 'minute',
      currency: rateSnapshot.currency || 'USD',
      prefix: rateSnapshot.matchedPrefix,
      source: rateSnapshot.resolutionSource,
      pricingPolicyId: rateSnapshot.matchedRateCard.metadata?.pricing_policy_id,
      pricingMode: rateSnapshot.matchedRateCard.metadata?.pricing_mode,
      markupBasisPoints: rateSnapshot.matchedRateCard.metadata?.markup_basis_points || 2500,
      providerKey: rateSnapshot.matchedRateCard.metadata?.provider_key || 'twilio',
      providerAccountId,
      numberType: trustedNumberType,
      freshnessState: rateSnapshot.matchedRateCard.metadata?.freshness_state,
      pricingFingerprint: rateSnapshot.matchedRateCard.metadata?.pricing_fingerprint,
      authorizationTimestamp: rateSnapshot.matchedRateCard.metadata?.authorization_timestamp || new Date().toISOString(),
    };

    // 5. Reserve usage against shared organization Credits wallet in enforce mode
    if (enforcementMode === 'enforce') {
      try {
        const reservationResult = await TelecomWalletService.reserveUsage(client, {
          organizationId,
          serviceType: 'voice_inbound',
          direction: 'inbound',
          internalUsageId,
          amountReservedMinor,
          idempotencyKey,
          rateSnapshot: rateSnapshotPayload as any,
          metadata: {
            callSid: cleanCallSid,
            calledNumber: cleanCalled,
            callerNumber: callerNumber || '',
            initialExposureSeconds,
          },
        });
        reservationId = reservationResult.reservationId;
      } catch (resErr: any) {
        if (resErr.message && resErr.message.includes('INSUFFICIENT_FUNDS')) {
          throw new InboundVoiceAuthorizationError(
            'Insufficient Credits available in wallet for inbound call.',
            402,
            'INSUFFICIENT_FUNDS'
          );
        }
        throw new InboundVoiceAuthorizationError(`Reservation error: ${resErr.message}`, 500, 'RESERVATION_ERROR');
      }
    }

    // Record confidential wholesale economics snapshot
    if (reservationId) {
      await TelecomWholesaleService.recordWholesaleSnapshot(client, {
        organizationId,
        reservationId,
        internalUsageId,
        providerKey: 'twilio',
        serviceType: 'voice_inbound',
        direction: 'inbound',
        currency: rateSnapshot.currency || 'USD',
        estimatedWholesaleRateMicro: rateSnapshot.matchedRateCard?.wholesaleCostMicro || 0,
        estimatedWholesaleCostMinor: TelecomWalletService.calculateRetailChargeMinor({
          retailRateMicro: rateSnapshot.matchedRateCard?.wholesaleCostMicro || 0,
          durationSeconds: initialExposureSeconds,
          unitType: 'minute',
          billingIncrementSeconds: 60,
          minChargeableUnits: 1,
        }),
        metadata: {
          pricing_policy_id: rateSnapshot.matchedRateCard?.metadata?.pricing_policy_id,
          pricing_mode: rateSnapshot.matchedRateCard?.metadata?.pricing_mode,
        },
      });
    }

    // 6. Create durable telecom usage session & component
    try {
      await TelecomDomainService.createSession(client, {
        sessionId,
        organizationId,
        sessionType: 'inbound_call',
        direction: 'inbound',
        currency: rateSnapshot.currency || 'USD',
        metadata: { callSid: cleanCallSid, rateSnapshot: rateSnapshotPayload },
      });

      await TelecomDomainService.createComponent(client, {
        componentId,
        sessionId,
        organizationId,
        internalUsageId,
        provider: 'twilio',
        parentProviderResourceId: cleanCallSid,
        legType: 'pstn_inbound',
        metadata: { callerNumber, calledNumber },
      });
    } catch (domainErr: any) {
      console.warn('[InboundVoiceAuthorizationService] Non-fatal domain setup notice:', domainErr.message || domainErr);
    }

    return {
      authorized: true,
      organizationId,
      sessionId,
      componentId,
      internalUsageId,
      reservationId,
      amountReservedMinor,
      rateSnapshot,
      enforcementMode,
    };
  }
}
