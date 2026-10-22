import { createAdminClient } from '@/lib/supabase/admin';
import { normalizeE164PhoneNumber } from '@/lib/utils';
import { computeDestinationFingerprint } from '@/lib/telephony/experimentCrypto';

export interface CreateOutboundCallParams {
  userId: string;
  organizationId: string;
  destination: string;
  fromNumber?: string;
  recordCall?: boolean;
  defaultCountry?: string;
}

export interface CreateOutboundCallResult {
  success: boolean;
  callId: string;
  call: any;
}

export class OutboundCallError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number = 400) {
    super(message);
    this.name = 'OutboundCallError';
    this.statusCode = statusCode;
  }
}

/**
 * Authoritative Server-Only Outbound Call Setup Business Logic.
 * Shared across web API (/api/twilio/calls/create) and Chrome Extension API (/api/extension/calls/create).
 */
export async function executeOutboundCallSetup(
  params: CreateOutboundCallParams
): Promise<CreateOutboundCallResult> {
  const { userId, organizationId, destination, fromNumber: rawFromNumber, recordCall = false } = params;

  if (!userId || !organizationId) {
    throw new OutboundCallError('Forbidden. User profile or organization unconfigured.', 403);
  }

  const adminSupabase = createAdminClient();

  // 0. Server-Side Entitlement & Subscription Policy Enforcement
  const { hasEntitlement } = await import('@/lib/entitlements/server');
  const { SubscriptionPolicyService } = await import('@/lib/billing/subscriptionPolicyService');

  const voiceEnabled = await hasEntitlement('voice.calling', adminSupabase);
  if (!voiceEnabled) {
    throw new OutboundCallError('Calling feature is not included in your subscription plan.', 403);
  }

  const mayCall = await SubscriptionPolicyService.mayUseExistingTelecom(organizationId, adminSupabase);
  if (!mayCall) {
    throw new OutboundCallError('Subscription state restricts calling. Outbound calls are disabled.', 403);
  }

  // 1. Clean up expired agent reservations
  await (adminSupabase as any)
    .from('agent_call_reservations')
    .delete()
    .lte('expires_at', new Date().toISOString());

  // 2. Atomic outbound reservation lock: Guarantee only 1 call setup per user at a time
  const expiresAt = new Date(Date.now() + 45 * 1000).toISOString();
  const { data: resRow, error: resErr } = await (adminSupabase as any)
    .from('agent_call_reservations')
    .insert({
      organization_id: organizationId,
      user_id: userId,
      reservation_type: 'outbound',
      expires_at: expiresAt,
    })
    .select('id')
    .maybeSingle();

  if (resErr || !resRow) {
    throw new OutboundCallError(
      'You already have an active call or pending call setup. Finish your current call before starting another.',
      409
    );
  }

  const reservationId = resRow.id;

  try {
    // 3. Check if agent already owns an active call row in database (with stale 'initiated' safety net)
    const { data: existingActiveCalls } = await (adminSupabase as any)
      .from('calls')
      .select('id, status, started_at, created_at')
      .eq('organization_id', organizationId)
      .in('status', ['initiated', 'ringing', 'in-progress', 'queued'])
      .eq('user_id', userId);

    if (existingActiveCalls && existingActiveCalls.length > 0) {
      const nowMs = Date.now();
      const STALE_INITIATED_THRESHOLD_MS = 60 * 1000; // 60s threshold (exceeds 45s reservation TTL)

      let hasGenuineActiveCall = false;

      for (const callRow of existingActiveCalls) {
        if (callRow.status === 'initiated') {
          const startTimeStr = callRow.started_at || callRow.created_at;
          const startTimeMs = startTimeStr ? new Date(startTimeStr).getTime() : 0;
          const ageMs = nowMs - startTimeMs;

          if (ageMs > STALE_INITIATED_THRESHOLD_MS) {
            console.log(`[Outbound Call Setup] Found stale initiated call "${callRow.id}" (age: ${Math.round(ageMs / 1000)}s). Terminalizing as failed.`);
            const nowIso = new Date().toISOString();
            await (adminSupabase as any)
              .from('calls')
              .update({
                status: 'failed',
                ended_at: nowIso,
                updated_at: nowIso,
              })
              .eq('id', callRow.id);

            await (adminSupabase as any)
              .from('agent_call_reservations')
              .delete()
              .eq('call_id', callRow.id);
          } else {
            hasGenuineActiveCall = true;
          }
        } else {
          // 'ringing', 'in-progress', or 'queued' calls are genuine active calls
          hasGenuineActiveCall = true;
        }
      }

      if (hasGenuineActiveCall) {
        throw new OutboundCallError(
          'You already have an active call. Finish your current call before starting another.',
          409
        );
      }
    }

    // 4. Extract & validate destination E.164 phone number
    const validation = normalizeE164PhoneNumber(destination || '', params.defaultCountry);
    if (!validation.isValid || !validation.normalized) {
      throw new OutboundCallError(validation.error || 'Invalid destination phone number.', 400);
    }

    const normalizedDestination = validation.normalized;

    // 4b. Centralized Destination Risk & Emergency Number Policy Gateway
    const { DestinationRiskService } = await import('@/lib/telecom/fraud/destinationRiskService');
    const { TelecomSecurityAuditService } = await import('@/lib/telecom/fraud/telecomSecurityAuditService');

    const orgPolicy = await DestinationRiskService.getOrgGeographicPolicy(adminSupabase, organizationId);
    const riskEval = DestinationRiskService.evaluateDestination(normalizedDestination, orgPolicy);
    if (riskEval.classification === 'BLOCKED' || riskEval.isEmergency) {
      await TelecomSecurityAuditService.logSecurityEvent(adminSupabase, {
        organizationId,
        userId,
        destination: normalizedDestination,
        riskRule: riskEval.riskRule || (riskEval.isEmergency ? 'EMERGENCY_DESTINATION_GATE' : 'DESTINATION_RISK_BLOCKED'),
        operation: 'voice_dial',
        decision: 'blocked',
        reason: riskEval.reason,
        metadata: {
          countryCode: riskEval.countryCode,
        },
      });
      throw new OutboundCallError(riskEval.reason, 403);
    }

    // 4c. Voice Velocity Controls (Non-bypassable by Owner/Admin - Phase 24C Distributed Atomic)
    const { TelecomVelocityService } = await import('@/lib/telecom/fraud/telecomVelocityService');
    const velocityCheck = await TelecomVelocityService.checkAndConsumeVoice(adminSupabase, {
      organizationId,
      userId,
      serviceType: 'voice_outbound',
      destination: normalizedDestination,
      idempotencyKey: (params as any).callId || undefined,
    });

    if (!velocityCheck.allowed) {
      await TelecomSecurityAuditService.logSecurityEvent(adminSupabase, {
        organizationId,
        userId,
        destination: normalizedDestination,
        riskRule: velocityCheck.limitType?.toUpperCase() || 'VOICE_VELOCITY_EXCEEDED',
        operation: 'voice_dial',
        decision: 'throttled',
        reason: velocityCheck.reason || 'Voice call velocity throttled.',
      });
      throw new OutboundCallError(velocityCheck.reason || 'Voice call velocity exceeded. Please slow down.', 429);
    }

    // 5. Blocked-number check for organization
    const { data: blockedRecord } = await (adminSupabase as any)
      .from('blocked_numbers')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('normalized_phone', normalizedDestination)
      .maybeSingle();

    if (blockedRecord) {
      throw new OutboundCallError('This number is blocked. Unblock it before calling.', 403);
    }

    const { data: blockedContact } = await (adminSupabase as any)
      .from('contacts')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('phone', normalizedDestination)
      .eq('is_blocked', true)
      .is('archived_at', null)
      .maybeSingle();

    if (blockedContact) {
      throw new OutboundCallError('This number is blocked. Unblock it before calling.', 403);
    }

    // 5b. Advisory Preflight Credit Check (ADVISORY ONLY - No reservation, no ledger movement)
    const { ExposurePolicy } = await import('@/lib/billing/telecom/exposurePolicy');
    const { enforcementMode } = ExposurePolicy.getConfig();
    if (enforcementMode === 'enforce') {
      try {
        const { TelecomWalletService } = await import('@/lib/billing/telecomWalletService');
        const summary = await TelecomWalletService.getWalletSummary(adminSupabase, organizationId);
        if (summary.availableBalanceMinor <= 0) {
          throw new OutboundCallError('Your account has insufficient Credits to place this call. Please add Credits to continue.', 402);
        }
      } catch (preflightErr: any) {
        if (preflightErr instanceof OutboundCallError) {
          throw preflightErr;
        }
        console.warn('[Advisory Preflight] Error during advisory credit check:', preflightErr.message || preflightErr);
      }
    }

    // 6. Resolve & validate caller ID Business Number (Phase 7.4 Role-Based Access)
    const { data: userProfile } = await (adminSupabase as any)
      .from('profiles')
      .select('id, organization_id, role, active, telecom_suspended')
      .eq('id', userId)
      .maybeSingle();

    if (!userProfile || userProfile.active === false || userProfile.organization_id !== organizationId) {
      throw new OutboundCallError('Forbidden. Active user profile required.', 403);
    }

    const isOwnerOrAdmin = ['owner', 'admin'].includes(userProfile.role || '');
    let callerId = (rawFromNumber || '').trim();

    const { NumberPermissionService } = await import('@/lib/telecom/assignment');
    // Phase 23D.5: NumberPermissionService.canActorUseNumber composes CapabilityAuthorizationService.canUseCapability with canonical assignment authority

    if (callerId) {
      // Explicit caller ID requested: verify permission & capability
      const perm = await NumberPermissionService.canActorUseNumber(
        {
          organizationId,
          actorId: userId,
          phoneNumberE164: callerId,
          operation: 'VOICE_OUTBOUND',
        },
        adminSupabase
      );

      if (!perm.allowed) {
        throw new OutboundCallError(
          perm.reason || 'The selected business number is not authorized for outbound voice by your user account.',
          perm.code === 'INSUFFICIENT_PERMISSIONS' || perm.code === 'NOT_ASSIGNED_TO_NUMBER' ? 403 : 400
        );
      }
    } else {
      // Auto-selection of caller ID
      if (isOwnerOrAdmin) {
        const { data: primaryCandidates } = await (adminSupabase as any)
          .from('phone_numbers')
          .select('id, phone_number, is_primary')
          .eq('organization_id', organizationId)
          .order('is_primary', { ascending: false });

        for (const candidate of primaryCandidates || []) {
          const perm = await NumberPermissionService.canActorUseNumber(
            {
              organizationId,
              actorId: userId,
              phoneNumberId: candidate.id,
              operation: 'VOICE_OUTBOUND',
            },
            adminSupabase
          );
          if (perm.allowed) {
            callerId = candidate.phone_number;
            break;
          }
        }
      } else {
        // Manager/Agent: Check numbers assigned directly or via projection
        const { data: userAssignments } = await (adminSupabase as any)
          .from('phone_numbers')
          .select('id, phone_number, is_primary, assignment_target_type, assignment_target_id')
          .eq('organization_id', organizationId);

        for (const candidate of userAssignments || []) {
          const perm = await NumberPermissionService.canActorUseNumber(
            {
              organizationId,
              actorId: userId,
              phoneNumberId: candidate.id,
              operation: 'VOICE_OUTBOUND',
            },
            adminSupabase
          );
          if (perm.allowed) {
            callerId = candidate.phone_number;
            break;
          }
        }
      }

      if (!callerId) {
        throw new OutboundCallError(
          isOwnerOrAdmin
            ? 'No active business number with usable voice capability is available for this workspace.'
            : 'No business number with usable voice capability assigned to your user account.',
          isOwnerOrAdmin ? 400 : 403
        );
      }
    }

    // 6b2. Phase 24B: Local Parent-Protection Control Plane & Outbound Voice Circuit Breaker
    const { TelecomControlPlaneService } = await import('@/lib/telecom/controlPlane');
    const controlEval = await TelecomControlPlaneService.evaluate(
      {
        organizationId,
        operation: 'OUTBOUND_VOICE',
        userId,
        phoneNumber: callerId,
        destination: normalizedDestination,
      },
      adminSupabase
    );
    if (!controlEval.allowed) {
      throw new OutboundCallError(controlEval.reason, 403);
    }

    // 6c. Multi-tier Telecom Suspension Kill Switches (User, Number, Org)
    const { TelecomSuspensionService } = await import('@/lib/telecom/fraud/telecomSuspensionService');
    const suspension = await TelecomSuspensionService.checkSuspension(adminSupabase, {
      organizationId,
      userId,
      phoneNumber: callerId,
    });

    if (suspension.isSuspended) {
      await TelecomSecurityAuditService.logSecurityEvent(adminSupabase, {
        organizationId,
        userId,
        phoneNumber: callerId,
        destination: normalizedDestination,
        riskRule: `TELECOM_SUSPENSION_${suspension.level}`,
        operation: 'voice_dial',
        decision: 'blocked',
        reason: suspension.reason || 'Telecom access suspended.',
      });
      throw new OutboundCallError(suspension.reason || 'Telecom access suspended.', 403);
    }

    // 6b. Verify recordings entitlement for recordCall parameter
    let effectiveRecordCall = Boolean(recordCall);
    if (effectiveRecordCall) {
      const recordingsEnabled = await hasEntitlement('recordings', adminSupabase);
      if (!recordingsEnabled) {
        effectiveRecordCall = false;
      }
    }

    // 7. Insert database call record into public.calls
    const { data: callRecord, error: insertError } = await (adminSupabase as any)
      .from('calls')
      .insert({
        organization_id: organizationId,
        user_id: userId,
        direction: 'outbound',
        from_number: callerId,
        to_number: normalizedDestination,
        status: 'initiated',
        record_call: effectiveRecordCall,
        started_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (insertError || !callRecord) {
      console.error('Error creating database call record:', insertError);
      throw new OutboundCallError('Failed to create database call log.', 500);
    }

    // Record voice velocity attempt on successful call initiation
    TelecomVelocityService.recordVoiceAttempt({
      organizationId,
      userId,
      serviceType: 'voice_outbound',
      destination: normalizedDestination,
    });

    // 8. Atomically claim any armed experiment authorization for this org & destination fingerprint (60s lease)
    try {
      const destFingerprint = computeDestinationFingerprint(normalizedDestination);
      const { data: expClaimResult } = await (adminSupabase as any).rpc(
        'claim_telecom_experiment_authorization_atomic',
        {
          p_organization_id: organizationId,
          p_call_id: callRecord.id,
          p_destination_fingerprint: destFingerprint,
          p_claim_lease_seconds: 60,
        }
      );

      if (expClaimResult?.claimed) {
        console.log('[Outbound Call Setup] Controlled experiment authorization CLAIMED for call:', {
          callId: callRecord.id,
          authorizationId: expClaimResult.authorization_id,
          initialExposureSeconds: expClaimResult.initial_exposure_seconds,
          enforcementMode: expClaimResult.enforcement_mode,
          claimExpiresAt: expClaimResult.claim_expires_at,
        });
      }
    } catch (expErr: any) {
      console.warn('[Outbound Call Setup] Experiment authorization claim check error:', expErr.message || expErr);
    }

    // 9. Update reservation to link call_id
    await (adminSupabase as any)
      .from('agent_call_reservations')
      .update({ call_id: callRecord.id })
      .eq('id', reservationId);

    return {
      success: true,
      callId: callRecord.id,
      call: callRecord,
    };
  } catch (error: any) {
    // Outbound failure cleanup: Release reservation immediately if any validation or DB step failed
    await (adminSupabase as any)
      .from('agent_call_reservations')
      .delete()
      .eq('id', reservationId);

    if (error instanceof OutboundCallError) {
      throw error;
    }
    const errorMessage = error.message || 'Failed to initiate call.';
    const status = errorMessage.includes('blocked') ? 403 : errorMessage.includes('active call') ? 409 : 400;
    throw new OutboundCallError(errorMessage, status);
  }
}
