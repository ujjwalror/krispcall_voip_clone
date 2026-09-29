import { SupabaseClient } from '@supabase/supabase-js';
import { TelecomRatingService } from './telecomRatingService';
import { TelecomWalletService } from '../telecomWalletService';
import { TelecomDomainService } from './telecomDomainService';
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
   * Performs server-authoritative called-number tenant lookup, rate resolution with metadata filtering,
   * bounded initial exposure calculation, and atomic wallet reservation.
   *
   * FAILS CLOSED if:
   * 1. Called number is unconfigured, inactive, or not assigned to an active tenant.
   * 2. No matching inbound retail rate card exists or rate resolution is ambiguous.
   * 3. Wallet available balance is insufficient in enforce mode.
   */
  public static async authorizeInboundCall(
    client: SupabaseClient,
    params: InboundVoiceAuthorizationParams
  ): Promise<InboundVoiceAuthorizationResult> {
    const { callSid, calledNumber, callerNumber, overrideInitialExposureSeconds } = params;

    const cleanCallSid = (callSid || '').trim();
    if (!cleanCallSid) {
      throw new InboundVoiceAuthorizationError('Missing required CallSid for inbound authorization', 400, 'INVALID_CALL_SID');
    }

    const cleanCalled = (calledNumber || '').trim();
    if (!cleanCalled) {
      throw new InboundVoiceAuthorizationError('Missing destination called phone number', 400, 'INVALID_CALLED_NUMBER');
    }

    // 1. Resolve tenant-owned active phone number metadata
    const { data: phoneRecord, error: phoneErr } = await client
      .from('phone_numbers')
      .select('id, organization_id, active, type, country_code, capabilities_voice')
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

    const organizationId = phoneRecord.organization_id;

    // Verify voice capability
    if (phoneRecord.capabilities_voice === false) {
      throw new InboundVoiceAuthorizationError(
        `Destination number "${cleanCalled}" does not have voice capability active.`,
        400,
        'VOICE_CAPABILITY_DISABLED'
      );
    }

    // Check rate card ambiguity for winning destination prefix
    const { data: activeCards } = await client
      .from('telecom_retail_rate_cards')
      .select('*')
      .eq('service_type', 'voice_inbound')
      .eq('direction', 'inbound')
      .eq('is_active', true)
      .eq('currency', 'USD');

    if (activeCards && activeCards.length > 1) {
      const cleanDest = cleanCalled.trim();
      let maxLen = -1;
      const prefixMatches: any[] = [];

      for (const card of activeCards) {
        const pat = (card.destination_pattern || '*').trim();
        if (pat === '*' && maxLen <= 0) {
          maxLen = 0;
          prefixMatches.push(card);
        } else if (cleanDest.startsWith(pat)) {
          if (pat.length > maxLen) {
            maxLen = pat.length;
            prefixMatches.length = 0;
            prefixMatches.push(card);
          } else if (pat.length === maxLen) {
            prefixMatches.push(card);
          }
        }
      }

      // If multiple rate cards match the exact same winning longest prefix with different rates -> FAIL CLOSED!
      if (prefixMatches.length > 1) {
        const rates = new Set(prefixMatches.map((c) => Number(c.retail_rate_micro)));
        if (rates.size > 1) {
          throw new InboundVoiceAuthorizationError(
            'Ambiguous rate cards for destination. Failing closed.',
            400,
            'AMBIGUOUS_RATE_CARD'
          );
        }
      }
    }

    // 2. Resolve inbound retail rate card
    let rateSnapshot: RateResolutionResult;
    try {
      rateSnapshot = await TelecomRatingService.resolveRetailRate(client, {
        organizationId,
        provider: 'twilio',
        serviceType: 'voice_inbound',
        direction: 'inbound',
        destinationPhoneNumber: cleanCalled,
        currency: 'USD',
      });
    } catch (rateErr: any) {
      throw new InboundVoiceAuthorizationError(
        `Inbound rate resolution failed: ${rateErr.message}`,
        400,
        'RATE_CARD_NOT_FOUND'
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
          rateSnapshot: rateSnapshot as any,
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

    // 6. Create durable telecom usage session & component
    try {
      await TelecomDomainService.createSession(client, {
        sessionId,
        organizationId,
        sessionType: 'inbound_call',
        direction: 'inbound',
        currency: rateSnapshot.currency || 'USD',
        metadata: { callSid: cleanCallSid, rateSnapshot },
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
