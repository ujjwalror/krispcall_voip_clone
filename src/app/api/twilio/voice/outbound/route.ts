import { NextResponse } from 'next/server';
import twilio from 'twilio';
import { normalizeE164PhoneNumber } from '@/lib/utils';
import { validateTwilioRequest } from '@/lib/twilio/signature';
import { createAdminClient } from '@/lib/supabase/admin';
import { VoiceAuthorizationService } from '@/lib/billing/telecom/voiceAuthorizationService';
import { ExposurePolicyConfig } from '@/lib/billing/telecom/exposurePolicy';

/**
 * Renders authoritative <Dial> TwiML bounded strictly by reservation-derived providerTimeLimit.
 * Validates providerTimeLimit and throws if invalid (fail closed).
 */
export function generateOutboundDialTwiml(params: {
  callerId: string;
  destination: string;
  providerTimeLimit: number;
  dbCallId: string;
  shouldRecord?: boolean;
  baseUrl?: string;
}): string {
  if (!VoiceAuthorizationService.isValidProviderTimeLimit(params.providerTimeLimit)) {
    throw new Error(
      `[generateOutboundDialTwiml] Invalid providerTimeLimit (${params.providerTimeLimit}): must be positive integer seconds backed by reservation`
    );
  }

  const baseUrl = params.baseUrl || process.env.NEXT_PUBLIC_APP_URL || 'https://krispcall-voip-clone-udlg.vercel.app';
  const voiceResponse = new twilio.twiml.VoiceResponse();

  const dialOptions: Record<string, any> = {
    callerId: params.callerId,
    timeLimit: params.providerTimeLimit,
  };

  if (params.shouldRecord) {
    const recordingStatusCallbackUrl = `${baseUrl}/api/twilio/recording?dbCallId=${encodeURIComponent(params.dbCallId)}`;
    dialOptions.record = 'record-from-answer';
    dialOptions.recordingStatusCallback = recordingStatusCallbackUrl;
    dialOptions.recordingStatusCallbackEvent = 'completed';
    dialOptions.recordingStatusCallbackMethod = 'POST';
  }

  const dial = voiceResponse.dial(dialOptions);

  const statusCallbackUrl = `${baseUrl}/api/twilio/status?dbCallId=${encodeURIComponent(params.dbCallId)}`;
  const numberOptions: Record<string, any> = {
    statusCallback: statusCallbackUrl,
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    statusCallbackMethod: 'POST',
  };

  dial.number(numberOptions, params.destination);

  return voiceResponse.toString();
}

/**
 * Outbound Voice TwiML Webhook Endpoint for Twilio Programmable Voice.
 * Performs authoritative pre-exposure financial authorization before issuing TwiML <Dial>.
 */
export async function POST(request: Request) {
  let createdReservationId: string | undefined = undefined;
  let targetOrgId: string | undefined = undefined;
  let targetInternalUsageId: string | undefined = undefined;

  try {
    const params: Record<string, string> = {};

    // 1. Parse incoming request parameters (Twilio sends application/x-www-form-urlencoded)
    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      formData.forEach((value, key) => {
        if (typeof value === 'string') {
          params[key] = value;
        }
      });
    } else if (contentType.includes('application/json')) {
      const json = await request.json().catch(() => ({}));
      Object.assign(params, json);
    }

    // Fallback query parameters
    const { searchParams } = new URL(request.url);
    searchParams.forEach((val, key) => {
      if (!params[key]) params[key] = val;
    });

    // 2. Verify webhook signature (if TWILIO_AUTH_TOKEN is configured)
    const isValidSignature = await validateTwilioRequest(request, params);
    if (!isValidSignature) {
      console.warn('[Twilio Outbound Webhook] Signature validation failed.');
      const errorResponse = new twilio.twiml.VoiceResponse();
      errorResponse.say({ voice: 'alice' }, 'Unauthorized Twilio webhook request.');
      errorResponse.hangup();
      return new NextResponse(errorResponse.toString(), {
        status: 403,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    // Extract CallSid and database call ID
    const callSid = params.CallSid || params.callSid || '';
    const dbCallId = params.dbCallId || params.db_call_id || searchParams.get('dbCallId') || '';

    let shouldRecord = params.recordCall === 'true' || params.record_call === 'true';

    console.log(`[Twilio Outbound Webhook] Processing CallSid: "${callSid}", dbCallId: "${dbCallId}"`);

    if (!dbCallId) {
      console.warn('[Twilio Outbound Webhook] Missing dbCallId parameter.');
      const errResp = new twilio.twiml.VoiceResponse();
      errResp.say({ voice: 'alice' }, 'We are unable to connect your call at this time. Please contact support.');
      errResp.hangup();
      return new NextResponse(errResp.toString(), {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    const adminSupabase = createAdminClient();

    // 3. Re-establish server-authoritative call record from database (must be in 'initiated' pre-authorization state)
    const { data: dbCallRec, error: fetchErr } = await (adminSupabase as any)
      .from('calls')
      .select('id, organization_id, user_id, from_number, to_number, record_call, status')
      .eq('id', dbCallId)
      .eq('status', 'initiated')
      .maybeSingle();

    if (fetchErr || !dbCallRec || !dbCallRec.organization_id || dbCallRec.status !== 'initiated') {
      console.error('[Twilio Outbound Webhook] Could not resolve valid initiated call record:', fetchErr || `status: ${dbCallRec?.status}`);
      const errResp = new twilio.twiml.VoiceResponse();
      errResp.say({ voice: 'alice' }, 'We are unable to connect your call at this time. Please contact support.');
      errResp.hangup();
      return new NextResponse(errResp.toString(), {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    targetOrgId = dbCallRec.organization_id;
    targetInternalUsageId = `call:outbound:${dbCallRec.id}`;

    if (!shouldRecord && dbCallRec.record_call) {
      shouldRecord = true;
    }

    // Server-side recordings entitlement check (Starter plan must NOT record calls)
    const { hasEntitlement } = await import('@/lib/entitlements/server');
    const recordingsEnabled = await hasEntitlement('recordings', adminSupabase);
    if (!recordingsEnabled) {
      shouldRecord = false;
    }

    // Destination phone number
    const rawDestination = params.To || params.to || dbCallRec.to_number || '';
    const validation = normalizeE164PhoneNumber(rawDestination);

    if (!validation.isValid || !validation.normalized) {
      console.warn('[Twilio Outbound Webhook] Invalid destination phone number:', rawDestination);
      const errResp = new twilio.twiml.VoiceResponse();
      errResp.say({ voice: 'alice' }, 'Invalid destination phone number specified.');
      errResp.hangup();
      return new NextResponse(errResp.toString(), {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    const callerId = dbCallRec.from_number || '';
    if (!callerId) {
      console.warn('[Twilio Outbound Webhook] Missing from_number on DB call record.');
      const errResp = new twilio.twiml.VoiceResponse();
      errResp.say({ voice: 'alice' }, 'No business number is assigned to this workspace.');
      errResp.hangup();
      return new NextResponse(errResp.toString(), {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    // 3b. Check for server-authoritative experiment policy override for this exact call (status = 'claimed')
    let policyConfigOverrides: Partial<ExposurePolicyConfig> | undefined = undefined;
    let isControlledExperiment = false;

    try {
      const { computeDestinationFingerprint } = await import('@/lib/telephony/experimentCrypto');
      const destFingerprint = computeDestinationFingerprint(validation.normalized);

      const { data: expAuthRow } = await (adminSupabase as any)
        .from('telecom_experiment_authorizations')
        .select('id, initial_exposure_seconds, max_initial_exposure_seconds, enforcement_mode, expires_at, claim_expires_at, destination_fingerprint')
        .eq('bound_call_id', dbCallId)
        .eq('organization_id', dbCallRec.organization_id)
        .eq('destination_fingerprint', destFingerprint)
        .in('status', ['claimed', 'consumed'])
        .maybeSingle();

      if (expAuthRow) {
        const nowMs = Date.now();
        const isParentValid = expAuthRow.expires_at && new Date(expAuthRow.expires_at).getTime() > nowMs;
        const isClaimValid = expAuthRow.status === 'consumed' || (expAuthRow.claim_expires_at && new Date(expAuthRow.claim_expires_at).getTime() > nowMs);

        if (!isParentValid || !isClaimValid) {
          console.error('[Twilio Outbound Webhook] Controlled experiment authorization claim is stale or expired. Failing closed with ZERO <Dial>:', {
            dbCallId,
            authId: expAuthRow.id,
            status: expAuthRow.status,
            isParentValid,
            isClaimValid,
          });

          await (adminSupabase as any)
            .from('calls')
            .update({
              status: 'failed',
              ended_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq('id', dbCallId);

          const errResp = new twilio.twiml.VoiceResponse();
          errResp.say({ voice: 'alice' }, 'Controlled experiment authorization has expired or is invalid. Call cannot be connected.');
          errResp.hangup();
          return new NextResponse(errResp.toString(), {
            status: 200,
            headers: { 'Content-Type': 'text/xml' },
          });
        }

        isControlledExperiment = true;
        policyConfigOverrides = {
          initialExposureSeconds: expAuthRow.initial_exposure_seconds,
          maxInitialExposureSeconds: expAuthRow.max_initial_exposure_seconds,
          enforcementMode: 'enforce',
        };

        console.log('[Twilio Outbound Webhook] Controlled experiment policy override ACTIVE for call:', {
          dbCallId,
          authId: expAuthRow.id,
          policyConfigOverrides,
        });
      }
    } catch (expCheckErr: any) {
      console.warn('[Twilio Outbound Webhook] Error querying experiment authorization:', expCheckErr.message || expCheckErr);
    }

    // 4. AUTHORITATIVE PRE-EXPOSURE FINANCIAL AUTHORIZATION
    const authResult = await VoiceAuthorizationService.authorizeOutboundVoice(adminSupabase, {
      organizationId: dbCallRec.organization_id,
      dbCallId: dbCallRec.id,
      userId: dbCallRec.user_id,
      fromNumber: callerId,
      toNumber: validation.normalized,
      policyConfigOverrides,
    });

    createdReservationId = authResult.reservationId;

    // Fail-Closed Invariant: Controlled experiment MUST NOT degrade to default shadow_log or unreserved <Dial>
    if (isControlledExperiment && (!authResult.authorized || !authResult.reservationId)) {
      console.error('[Twilio Outbound Webhook] Controlled experiment financial authorization or reservation hold FAILED. Failing closed with ZERO <Dial>:', {
        dbCallId,
        failureReason: authResult.failureReason,
      });

      await (adminSupabase as any)
        .from('calls')
        .update({
          status: 'failed',
          ended_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', dbCallId);

      const failResponse = new twilio.twiml.VoiceResponse();
      failResponse.say(
        { voice: 'alice' },
        'Controlled experiment pre-exposure credit reservation failed. Call terminated before PSTN dispatch.'
      );
      failResponse.hangup();

      return new NextResponse(failResponse.toString(), {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    // Financial Invariant: AUTHORIZATION FAILURE -> ZERO <Dial> -> ZERO PSTN exposure
    if (!authResult.authorized) {
      console.warn('[Twilio Outbound Webhook] Authorization failed:', authResult.failureReason);

      // Update call record status to failed
      await (adminSupabase as any)
        .from('calls')
        .update({
          status: 'failed',
          ended_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', dbCallId);

      const failResponse = new twilio.twiml.VoiceResponse();
      failResponse.say(
        { voice: 'alice' },
        authResult.customerMessage || 'We are unable to connect your call at this time. Please check your account balance or contact support.'
      );
      failResponse.hangup();

      return new NextResponse(failResponse.toString(), {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    // 5. AUTHORIZATION SUCCESS -> Link CallSid to DB call record
    if (callSid) {
      await (adminSupabase as any)
        .from('calls')
        .update({ twilio_call_sid: callSid, updated_at: new Date().toISOString() })
        .eq('id', dbCallId);
    }

    // Invariant: providerTimeLimit MUST be valid according to duration constraints:
    // present, numeric, finite, positive integer seconds backed by committed reservation.
    // In enforce mode, a committed reservationId is strictly mandatory.
    // If providerTimeLimit is missing, null, zero, negative, NaN, Infinity, or malformed: FAIL CLOSED.
    const isEnforceMode = !authResult.isShadowMode;
    const isValidProviderLimit = VoiceAuthorizationService.isValidProviderTimeLimit(authResult.providerTimeLimit);
    const isReservationValid = !isEnforceMode || Boolean(authResult.reservationId);

    if (!isValidProviderLimit || !isReservationValid) {
      console.error(
        '[Twilio Outbound Webhook] Outbound voice authorization failed boundary validation (missing/invalid providerTimeLimit or missing reservation):',
        {
          reservationId: authResult.reservationId,
          providerTimeLimit: authResult.providerTimeLimit,
          isEnforceMode,
          isValidProviderLimit,
          isReservationValid,
        }
      );

      if (createdReservationId && targetOrgId && targetInternalUsageId) {
        await VoiceAuthorizationService.compensatePreDispatchFailure(
          adminSupabase,
          targetOrgId,
          targetInternalUsageId,
          dbCallId
        );
      }

      await (adminSupabase as any)
        .from('calls')
        .update({
          status: 'failed',
          ended_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', dbCallId);

      const failResp = new twilio.twiml.VoiceResponse();
      failResp.say(
        { voice: 'alice' },
        'We are unable to connect your call due to an authorization or credit reservation error. Please contact support.'
      );
      failResp.hangup();

      return new NextResponse(failResp.toString(), {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    // Locked Invariant: <Dial timeLimit> must consume ONLY the authoritative bounded providerTimeLimit
    // derived strictly from the funds atomically secured in the reservation.
    // Unsafe fallbacks (timeLimitSeconds, 300, 3600, total affordability) are strictly prohibited.
    const finalTimeLimitSeconds = authResult.providerTimeLimit as number;

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://krispcall-voip-clone-udlg.vercel.app';
    const twimlOutput = generateOutboundDialTwiml({
      callerId,
      destination: validation.normalized,
      providerTimeLimit: finalTimeLimitSeconds,
      dbCallId,
      shouldRecord,
      baseUrl,
    });

    // Record provider resource mapping for CALL
    if (callSid && targetOrgId) {
      try {
        const { ProviderResourceManager } = await import('@/lib/telecom/provider/providerResourceManager');
        const { ProviderAccountResolver } = await import('@/lib/telecom/provider/providerAccountResolver');
        const providerRes = await ProviderAccountResolver.resolveAccount({
          organizationId: targetOrgId,
          service: 'VOICE',
        }, adminSupabase);

        const providerAccountId = providerRes.context?.providerAccountId || 'default';
        await ProviderResourceManager.recordResource(
          {
            organizationId: targetOrgId,
            providerAccountId,
            resourceType: 'CALL',
            localResourceId: dbCallId,
            remoteResourceId: callSid,
            provider: 'TWILIO',
            status: 'initiated',
          },
          adminSupabase
        );
      } catch (mappingErr) {
        console.warn('[Twilio Outbound Webhook] Non-fatal provider resource mapping error:', mappingErr);
      }
    }

    return new NextResponse(twimlOutput, {
      status: 200,
      headers: {
        'Content-Type': 'text/xml',
      },
    });
  } catch (error: any) {
    console.error('[Twilio Outbound Webhook] Exception processing outbound call webhook:', error.message || error);

    // Safe pre-dispatch failure compensation: If reservation succeeded but local response setup crashed
    if (createdReservationId && targetOrgId && targetInternalUsageId) {
      try {
        const adminSupabase = createAdminClient();
        await VoiceAuthorizationService.compensatePreDispatchFailure(
          adminSupabase,
          targetOrgId,
          targetInternalUsageId,
          targetInternalUsageId.replace('call:outbound:', '')
        );
      } catch (compErr) {
        console.error('[Twilio Outbound Webhook] Downstream compensation error:', compErr);
      }
    }

    const errorResponse = new twilio.twiml.VoiceResponse();
    errorResponse.say({ voice: 'alice' }, 'An error occurred while processing the outbound call. Please try again.');
    errorResponse.hangup();
    return new NextResponse(errorResponse.toString(), {
      status: 500,
      headers: { 'Content-Type': 'text/xml' },
    });
  }
}

export async function GET(request: Request) {
  return POST(request);
}
