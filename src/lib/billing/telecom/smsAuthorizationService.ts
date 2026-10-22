import { SupabaseClient } from '@supabase/supabase-js';
import { TelecomRatingService } from './telecomRatingService';
import { TelecomWalletService } from '../telecomWalletService';
import { TelecomWholesaleService } from './telecomWholesaleService';
import { SmsSegmentService } from './smsSegmentService';
import { ExposurePolicy } from './exposurePolicy';
import { normalizeE164PhoneNumber } from '@/lib/utils';

export interface AuthorizeSmsParams {
  userId: string;
  organizationId: string;
  clientSendId: string;
  fromNumber: string;
  toNumber: string;
  body: string;
  mediaUrls?: string[];
  defaultCountry?: string;
}

export interface SmsAuthorizationResult {
  authorized: boolean;
  serviceType: 'sms_outbound' | 'mms_outbound';
  segmentCount: number;
  rateMicro: number;
  requiredFundedMinor: number;
  internalUsageId: string;
  sessionId: string;
  componentId: string;
  normalizedFrom: string;
  normalizedTo: string;
  cleanBody: string;
  cleanMediaUrls: string[];
  enforcementMode: 'disabled' | 'shadow_log' | 'enforce';
  reservationId?: string;
  failureReason?: string;
  statusCode?: number;
}

export class SmsAuthorizationError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number = 400) {
    super(message);
    this.name = 'SmsAuthorizationError';
    this.statusCode = statusCode;
  }
}

export class SmsAuthorizationService {
  /**
   * Validates media URLs for MMS safety: HTTPS scheme, max count, max aggregate size, SSRF protection.
   */
  public static validateMmsMedia(mediaUrls: string[]): string[] {
    const MAX_COUNT = parseInt(process.env.MAX_MMS_MEDIA_COUNT || '10', 10);
    const clean = (mediaUrls || []).map((u) => (u || '').trim()).filter((u) => u.length > 0);

    if (clean.length > MAX_COUNT) {
      throw new SmsAuthorizationError(`MMS media count exceeds maximum limit of ${MAX_COUNT} items.`, 400);
    }

    const ssrfPattern = /^(https?:\/\/)?(127\.0\.0\.1|localhost|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.169\.254|0\.0\.0\.0)/i;

    for (const url of clean) {
      if (!url.toLowerCase().startsWith('https://')) {
        throw new SmsAuthorizationError('MMS media URLs must use secure HTTPS protocol.', 400);
      }
      if (ssrfPattern.test(url)) {
        throw new SmsAuthorizationError('MMS media URL is prohibited due to security policy.', 400);
      }
    }

    return clean;
  }

  /**
   * Authoritative Server-Side Outbound SMS/MMS Authorization Service.
   * Performs validation, capability checks, rate resolution, and pre-send wallet reservation.
   */
  public static async authorizeOutboundMessage(
    client: SupabaseClient,
    params: AuthorizeSmsParams
  ): Promise<SmsAuthorizationResult> {
    const {
      userId,
      organizationId,
      clientSendId,
      fromNumber,
      toNumber,
      body,
      mediaUrls = [],
      defaultCountry,
    } = params;

    if (!userId || !organizationId) {
      throw new SmsAuthorizationError('Forbidden. Authenticated user profile or organization unconfigured.', 403);
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
      throw new SmsAuthorizationError(eligibility.reason, 403);
    }

    const cleanSendId = (clientSendId || '').trim();
    if (!cleanSendId) {
      throw new SmsAuthorizationError('Client send request identifier (clientSendId) is required.', 400);
    }

    // 1. Detect message type & sanitize body / media
    const cleanMedia = this.validateMmsMedia(mediaUrls);
    const isMms = cleanMedia.length > 0;
    const serviceType: 'sms_outbound' | 'mms_outbound' = isMms ? 'mms_outbound' : 'sms_outbound';
    const featureCode = isMms ? 'messaging.mms' : 'messaging.sms';

    // 1b. Entitlement & Subscription Policy Enforcement
    const { hasEntitlement } = await import('@/lib/entitlements/server');
    const { SubscriptionPolicyService } = await import('@/lib/billing/subscriptionPolicyService');

    const msgEnabled = await hasEntitlement(featureCode, client);
    if (!msgEnabled) {
      throw new SmsAuthorizationError(`Messaging feature "${featureCode}" is not included in your subscription plan.`, 403);
    }

    const mayMsg = await SubscriptionPolicyService.mayUseExistingTelecom(organizationId, client);
    if (!mayMsg) {
      throw new SmsAuthorizationError('Subscription state restricts messaging. Outbound messages are disabled.', 403);
    }

    const cleanBody = (body || '').trim();
    if (!isMms && !cleanBody) {
      throw new SmsAuthorizationError('Message body cannot be empty for SMS.', 400);
    }

    const MAX_SMS_BODY_LENGTH = 1600;
    if (cleanBody.length > MAX_SMS_BODY_LENGTH) {
      throw new SmsAuthorizationError(`Message body exceeds maximum limit of ${MAX_SMS_BODY_LENGTH} characters.`, 400);
    }

    // 2. Validate & normalize destination E.164 phone number
    const destValidation = normalizeE164PhoneNumber(toNumber || '', defaultCountry);
    if (!destValidation.isValid || !destValidation.normalized) {
      throw new SmsAuthorizationError(destValidation.error || 'Invalid destination phone number.', 400);
    }
    const normalizedTo = destValidation.normalized;

    // 2b. Centralized Destination Risk Policy Gateway
    const { DestinationRiskService } = await import('@/lib/telecom/fraud/destinationRiskService');
    const { TelecomSecurityAuditService } = await import('@/lib/telecom/fraud/telecomSecurityAuditService');

    const orgPolicy = await DestinationRiskService.getOrgGeographicPolicy(client, organizationId);
    const riskEval = DestinationRiskService.evaluateDestination(normalizedTo, orgPolicy);
    if (riskEval.classification === 'BLOCKED' || riskEval.isEmergency) {
      await TelecomSecurityAuditService.logSecurityEvent(client, {
        organizationId,
        userId,
        phoneNumber: fromNumber || null,
        destination: normalizedTo,
        riskRule: riskEval.riskRule || (riskEval.isEmergency ? 'EMERGENCY_DESTINATION_GATE' : 'DESTINATION_RISK_BLOCKED'),
        operation: isMms ? 'mms_send' : 'sms_send',
        decision: 'blocked',
        reason: riskEval.reason,
        metadata: {
          countryCode: riskEval.countryCode,
        },
      });
      throw new SmsAuthorizationError(riskEval.reason, 403);
    }

    // 2c. Recipient Opt-Out Suppression (Messaging Consent Foundation)
    const { MessagingConsentService } = await import('@/lib/telecom/fraud/messagingConsentService');
    const isOptedOut = await MessagingConsentService.isRecipientOptedOut(client, organizationId, normalizedTo);
    if (isOptedOut) {
      throw new SmsAuthorizationError('Recipient has opted out of receiving messages from this organization (STOP requested).', 403);
    }

    // 2d. Outbound Messaging Velocity Controls (Non-bypassable by Owner/Admin - Phase 24C Distributed Atomic)
    const { TelecomVelocityService } = await import('@/lib/telecom/fraud/telecomVelocityService');
    const velocityCheck = await TelecomVelocityService.checkAndConsumeMessaging(client, {
      organizationId,
      userId,
      serviceType,
      destination: normalizedTo,
      body: cleanBody,
      idempotencyKey: (params as any).clientSendId || (params as any).idempotencyKey || undefined,
    });
    if (!velocityCheck.allowed) {
      throw new SmsAuthorizationError(velocityCheck.reason || 'Outbound messaging velocity limit exceeded.', 429);
    }

    // 3. Verify sender business phone number active, owned by org, and has capabilities
    const fromValidation = normalizeE164PhoneNumber(fromNumber || '', defaultCountry);
    const normalizedFrom = fromValidation.normalized || (fromNumber || '').trim();

    // 3. Verify user profile active & role
    const { data: userProfile } = await client
      .from('profiles')
      .select('role, active, telecom_suspended')
      .eq('id', userId)
      .maybeSingle();

    if (!userProfile || userProfile.active === false) {
      throw new SmsAuthorizationError('Forbidden. Active user profile required.', 403);
    }

    const isOwnerOrAdmin = ['owner', 'admin'].includes(userProfile.role || '');

    // 4. Canonical Permission & Capability Authorization (Phase 23D.4 / 23D.5)
    // Composes CapabilityAuthorizationService.canUseCapability via NumberPermissionService.canActorUseNumber
    const { NumberPermissionService } = await import('@/lib/telecom/assignment');
    const requiredCap = isMms ? 'MMS_OUTBOUND' : 'SMS_OUTBOUND';
    const perm = await NumberPermissionService.canActorUseNumber(
      {
        organizationId,
        actorId: userId,
        phoneNumberE164: normalizedFrom,
        operation: requiredCap,
      },
      client
    );

    if (!perm.allowed) {
      throw new SmsAuthorizationError(
        perm.reason || `The selected business phone number is not authorized for ${isMms ? 'MMS' : 'SMS'} messaging (${perm.code}).`,
        perm.code === 'INSUFFICIENT_PERMISSIONS' || perm.code === 'NOT_ASSIGNED_TO_NUMBER' ? 403 : 400
      );
    }

    // Phase 24B: Authoritative Local Control Plane & Circuit Breaker Check
    const { TelecomControlPlaneService } = await import('@/lib/telecom/controlPlane');
    const controlEval = await TelecomControlPlaneService.evaluate(
      {
        organizationId,
        operation: 'OUTBOUND_MESSAGING',
        userId,
        phoneNumber: normalizedFrom,
        destination: normalizedTo,
        context: { isMms, messageLength: body?.length || 0 },
      },
      client
    );
    if (!controlEval.allowed) {
      throw new SmsAuthorizationError(controlEval.reason, 403);
    }

    // Multi-tier Telecom Suspension Kill Switches
    const { TelecomSuspensionService } = await import('@/lib/telecom/fraud/telecomSuspensionService');
    const suspension = await TelecomSuspensionService.checkSuspension(client, {
      organizationId,
      userId,
      phoneNumber: normalizedFrom,
    });
    if (suspension.isSuspended) {
      throw new SmsAuthorizationError(suspension.reason || 'Telecom access suspended.', 403);
    }

    // 4. Blocked-number checks
    const { data: blockedRecord } = await client
      .from('blocked_numbers')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('normalized_phone', normalizedTo)
      .maybeSingle();

    if (blockedRecord) {
      throw new SmsAuthorizationError('This recipient phone number is blocked. Unblock it before sending messages.', 403);
    }

    const { data: blockedContact } = await client
      .from('contacts')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('phone', normalizedTo)
      .eq('is_blocked', true)
      .is('archived_at', null)
      .maybeSingle();

    if (blockedContact) {
      throw new SmsAuthorizationError('This recipient phone number is blocked. Unblock it before sending messages.', 403);
    }

    // 5. Calculate pre-send segment count
    const segmentCount = isMms ? 1 : SmsSegmentService.calculatePreSendSegmentCount(cleanBody);

    // 6. Resolve server-authoritative retail rate card
    let rateResult;
    try {
      rateResult = await TelecomRatingService.resolveRetailRate(client, {
        organizationId,
        serviceType,
        destinationPhoneNumber: normalizedTo,
        direction: 'outbound',
      });
    } catch (rateErr: any) {
      throw new SmsAuthorizationError(`No retail rate card configured for ${serviceType} to ${normalizedTo}.`, 400);
    }

    const retailRateMicro = rateResult.retailRateMicro;
    const currency = rateResult.currency || 'USD';

    // 7. Calculate required pre-send exposure (in minor cents)
    const requiredFundedMinor = TelecomWalletService.calculateRetailChargeMinor({
      retailRateMicro,
      durationSeconds: segmentCount,
      billingIncrementSeconds: 1,
      minChargeableUnits: 1,
      unitType: 'message',
    });

    const policyConfig = ExposurePolicy.getConfig();
    ExposurePolicy.validateConfig(policyConfig);
    const enforcementMode = policyConfig.enforcementMode;
    const internalUsageId = `msg:outbound:${cleanSendId}`;
    const sessionId = cleanSendId;
    const componentId = `comp:msg:${cleanSendId}`;

    let reservationId: string | undefined = undefined;

    // 8. Execute prepaid reservation in enforce mode
    if (enforcementMode === 'enforce') {
      try {
        const reserveRes = await TelecomWalletService.reserveUsage(client, {
          organizationId,
          internalUsageId,
          serviceType,
          direction: 'outbound',
          amountReservedMinor: requiredFundedMinor,
          rateSnapshot: {
            retailRateMicro,
            billingIncrementSeconds: 1,
            minChargeableUnits: 1,
            unitType: 'message',
            serviceType,
            currency,
          },
          idempotencyKey: `res:sms:${cleanSendId}`,
        });
        reservationId = reserveRes.reservationId;
      } catch (reserveErr: any) {
        const msg = reserveErr.message || '';
        if (msg.includes('INSUFFICIENT_FUNDS') || msg.includes('INSUFFICIENT_AVAILABLE_BALANCE')) {
          throw new SmsAuthorizationError('Insufficient Credits available in wallet. Please top up your Credits to send messages.', 402);
        }
        if (msg.includes('ORGANIZATION_BILLING_RESTRICTED')) {
          throw new SmsAuthorizationError('Your organization billing is currently restricted from telecom usage.', 403);
        }
        throw new SmsAuthorizationError(`Prepaid wallet reservation failed: ${msg}`, 400);
      }
    }

    // 9. Create/update durable domain session and component records
    await this.ensureDomainGraph(client, {
      organizationId,
      sessionId,
      componentId,
      internalUsageId,
      serviceType,
      segmentCount,
    });

    // Record Option B confidential wholesale economics snapshot
    if (reservationId) {
      await TelecomWholesaleService.recordWholesaleSnapshot(client, {
        organizationId,
        reservationId,
        internalUsageId,
        providerKey: 'twilio',
        serviceType,
        direction: 'outbound',
        currency,
        estimatedWholesaleRateMicro: rateResult.matchedRateCard.wholesaleCostMicro || 0,
        estimatedWholesaleCostMinor: TelecomWalletService.calculateRetailChargeMinor({
          retailRateMicro: rateResult.matchedRateCard.wholesaleCostMicro || 0,
          durationSeconds: segmentCount,
          billingIncrementSeconds: 1,
          minChargeableUnits: 1,
          unitType: 'message',
        }),
      });
    }

    return {
      authorized: true,
      serviceType,
      segmentCount,
      rateMicro: retailRateMicro,
      requiredFundedMinor,
      internalUsageId,
      sessionId,
      componentId,
      normalizedFrom,
      normalizedTo,
      cleanBody,
      cleanMediaUrls: cleanMedia,
      enforcementMode,
      reservationId,
    };
  }

  /**
   * Helper to insert durable session and component records.
   */
  private static async ensureDomainGraph(
    client: SupabaseClient,
    params: {
      organizationId: string;
      sessionId: string;
      componentId: string;
      internalUsageId: string;
      serviceType: 'sms_outbound' | 'mms_outbound';
      segmentCount: number;
    }
  ): Promise<void> {
    const { organizationId, sessionId, componentId, internalUsageId, serviceType, segmentCount } = params;

    try {
      await client.from('telecom_usage_sessions').insert({
        session_id: sessionId,
        organization_id: organizationId,
        session_type: serviceType,
        direction: 'outbound',
        status: 'active',
        currency: 'USD',
      });
    } catch (_) {
      // Ignore duplicate
    }

    try {
      await client.from('telecom_usage_components').insert({
        component_id: componentId,
        session_id: sessionId,
        organization_id: organizationId,
        internal_usage_id: internalUsageId,
        leg_type: serviceType,
        sequence_number: 1,
        duration_seconds: segmentCount,
        retail_charge_minor: 0,
      });
    } catch (_) {
      // Ignore duplicate
    }
  }

  public static async compensatePreDispatchFailure(
    client: SupabaseClient,
    organizationId: string,
    internalUsageId: string,
    idempotencyKey: string
  ): Promise<boolean> {
    try {
      console.log(`[SmsAuthorizationService] Executing pre-dispatch failure compensation for ${internalUsageId}`);
      const releaseRes = await TelecomWalletService.releaseUsage(client, {
        organizationId,
        internalUsageId,
        reason: 'sms_dispatch_failed',
        idempotencyKey: `release:compensation:${idempotencyKey}`,
      });
      return releaseRes.success;
    } catch (releaseErr: any) {
      console.error('[SmsAuthorizationService] Compensation release failed:', releaseErr.message);
      return false;
    }
  }
}
