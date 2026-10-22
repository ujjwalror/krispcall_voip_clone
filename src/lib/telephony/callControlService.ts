import 'server-only';
import { SupabaseClient } from '@supabase/supabase-js';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { normalizeE164PhoneNumber } from '@/lib/utils';
import { VoiceAuthorizationService } from '@/lib/billing/telecom/voiceAuthorizationService';
import { DestinationRiskService } from '@/lib/telecom/fraud/destinationRiskService';
import { TelecomVelocityService } from '@/lib/telecom/fraud/telecomVelocityService';
import { TelecomSuspensionService } from '@/lib/telecom/fraud/telecomSuspensionService';
import { TelecomSecurityAuditService } from '@/lib/telecom/fraud/telecomSecurityAuditService';

export interface HoldCallParams {
  organizationId: string;
  userId: string;
  callSid: string;
  dbCallId?: string;
  hold: boolean;
}

export interface InternalTransferParams {
  organizationId: string;
  userId: string;
  callSid: string;
  dbCallId?: string;
  targetUserId: string;
  transferType?: 'blind' | 'warm';
}

export interface ExternalTransferParams {
  organizationId: string;
  userId: string;
  callSid: string;
  dbCallId?: string;
  transferOperationId?: string;
  externalNumber: string;
  transferType?: 'blind' | 'warm';
}

export class CallControlService {
  /**
   * Holds or resumes an active call leg.
   * Strict Tenant Isolation: Requires call record to belong to caller's organization.
   */
  static async setCallHold(
    params: HoldCallParams,
    clientOverride?: SupabaseClient
  ): Promise<{ success: boolean; state: 'held' | 'connected'; message: string }> {
    const supabase = clientOverride || (await createServerSupabaseClient());
    const { organizationId, userId, callSid, dbCallId, hold } = params;

    // 1. Verify caller/agent profile & organization membership
    const { data: profile } = await (supabase as any)
      .from('profiles')
      .select('id, organization_id, active')
      .eq('id', userId)
      .maybeSingle();

    if (!profile || profile.organization_id !== organizationId || profile.active === false) {
      return { success: false, state: hold ? 'connected' : 'held', message: 'Unauthorized agent session.' };
    }

    if (!callSid && !dbCallId) {
      return { success: false, state: hold ? 'connected' : 'held', message: 'Missing call identifier (callSid or dbCallId).' };
    }

    // 2. Fetch call record from DB and verify tenant ownership strictly
    let query = (supabase as any).from('calls').select('id, organization_id, status').eq('organization_id', organizationId);
    if (dbCallId) {
      query = query.eq('id', dbCallId);
    } else if (callSid) {
      query = query.eq('twilio_call_sid', callSid);
    }

    const { data: callRecord } = await query.maybeSingle();

    if (!callRecord) {
      // Fail closed: Cross-tenant call access or non-existent call
      await TelecomSecurityAuditService.logSecurityEvent(supabase, {
        organizationId,
        userId,
        riskRule: 'TENANT_RESOURCE_ISOLATION',
        operation: 'call_hold',
        decision: 'blocked',
        reason: 'Attempted to hold a call that does not belong to organization or does not exist.',
        metadata: { callSid, dbCallId },
      });

      return {
        success: false,
        state: hold ? 'connected' : 'held',
        message: 'Call not found or does not belong to your organization.',
      };
    }

    const targetStatus = hold ? 'held' : 'connected';

    // 3. Update call status in database atomically
    await (supabase as any)
      .from('calls')
      .update({
        status: targetStatus,
        updated_at: new Date().toISOString(),
      })
      .eq('id', callRecord.id)
      .eq('organization_id', organizationId);

    return {
      success: true,
      state: targetStatus,
      message: hold ? 'Call placed on hold.' : 'Call resumed.',
    };
  }

  /**
   * Transfers an active call to an internal team member (Blind Transfer).
   * Strict Tenant Isolation: Target member and CallSid must belong to caller's organization.
   */
  static async transferToInternalMember(
    params: InternalTransferParams,
    clientOverride?: SupabaseClient
  ): Promise<{ success: boolean; targetMemberName?: string; message: string }> {
    const supabase = clientOverride || (await createServerSupabaseClient());
    const { organizationId, userId, callSid, dbCallId, targetUserId } = params;

    if (userId === targetUserId) {
      return { success: false, message: 'Cannot transfer call to yourself.' };
    }

    // 1. Verify current agent session
    const { data: currentAgent } = await (supabase as any)
      .from('profiles')
      .select('id, organization_id, active')
      .eq('id', userId)
      .maybeSingle();

    if (!currentAgent || currentAgent.organization_id !== organizationId || currentAgent.active === false) {
      return { success: false, message: 'Unauthorized agent session.' };
    }

    // 2. Verify target team member belongs to SAME organization and is active
    const { data: targetMember } = await (supabase as any)
      .from('profiles')
      .select('id, full_name, email, organization_id, active, availability_status, twilio_identity')
      .eq('id', targetUserId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (!targetMember || targetMember.active === false) {
      return { success: false, message: 'Target team member does not belong to your organization or is inactive.' };
    }

    if (!callSid && !dbCallId) {
      return { success: false, message: 'Missing call identifier (callSid or dbCallId).' };
    }

    // 3. Verify call belongs to caller's organization strictly
    let query = (supabase as any).from('calls').select('id, organization_id').eq('organization_id', organizationId);
    if (dbCallId) query = query.eq('id', dbCallId);
    else query = query.eq('twilio_call_sid', callSid);

    const { data: callRow } = await query.maybeSingle();
    if (!callRow) {
      await TelecomSecurityAuditService.logSecurityEvent(supabase, {
        organizationId,
        userId,
        riskRule: 'TENANT_RESOURCE_ISOLATION',
        operation: 'call_transfer',
        decision: 'blocked',
        reason: 'Attempted to transfer a call that does not belong to organization or does not exist.',
        metadata: { callSid, dbCallId, targetUserId },
      });

      return {
        success: false,
        message: 'Call not found or does not belong to your organization.',
      };
    }

    // 4. Update call record in database
    await (supabase as any)
      .from('calls')
      .update({
        user_id: targetMember.id,
        status: 'transferred',
        updated_at: new Date().toISOString(),
      })
      .eq('id', callRow.id)
      .eq('organization_id', organizationId);

    return {
      success: true,
      targetMemberName: targetMember.full_name || targetMember.email,
      message: `Call transferred to ${targetMember.full_name || targetMember.email}.`,
    };
  }

  /**
   * Transfers an active call to an external PSTN phone number (External Transfer).
   * Enforces server-side tenant isolation, destination risk evaluation, suspension checks, velocity controls,
   * rate verification (wholesale + 25%) and wallet reservation.
   */
  static async transferToExternalNumber(
    params: ExternalTransferParams,
    clientOverride?: SupabaseClient
  ): Promise<{ success: boolean; normalizedNumber?: string; message: string }> {
    const supabase = clientOverride || (await createServerSupabaseClient());
    const { organizationId, userId, externalNumber, callSid, dbCallId } = params;

    // 1. Validate external phone number format
    const validation = normalizeE164PhoneNumber(externalNumber);
    if (!validation.isValid || !validation.normalized) {
      return { success: false, message: validation.error || 'Invalid external phone number E.164 format.' };
    }

    const cleanDest = validation.normalized;

    // 2. Verify agent session
    const { data: agent } = await (supabase as any)
      .from('profiles')
      .select('id, organization_id, active')
      .eq('id', userId)
      .maybeSingle();

    if (!agent || agent.organization_id !== organizationId || agent.active === false) {
      return { success: false, message: 'Unauthorized agent session.' };
    }

    if (!callSid && !dbCallId) {
      return { success: false, message: 'Missing call identifier (callSid or dbCallId) for external transfer.' };
    }

    // 3. Strictly verify call belongs to caller's organization
    let query = (supabase as any).from('calls').select('id, phone_number, from_number, organization_id').eq('organization_id', organizationId);
    if (dbCallId) query = query.eq('id', dbCallId);
    else query = query.eq('twilio_call_sid', callSid);

    const { data: callRow } = await query.maybeSingle();
    if (!callRow) {
      await TelecomSecurityAuditService.logSecurityEvent(supabase, {
        organizationId,
        userId,
        riskRule: 'TENANT_RESOURCE_ISOLATION',
        operation: 'call_transfer',
        decision: 'blocked',
        reason: 'Attempted to transfer a cross-tenant or non-existent call to external PSTN.',
        metadata: { callSid, dbCallId, externalNumber },
      });

      return {
        success: false,
        message: 'Call not found or does not belong to your organization.',
      };
    }

    const fromNumber = callRow.phone_number || callRow.from_number;
    if (!fromNumber) {
      return {
        success: false,
        message: 'Active call lacks a valid origination number.',
      };
    }

    // 4. Centralized Destination Risk Evaluation
    const orgPolicy = await DestinationRiskService.getOrgGeographicPolicy(supabase, organizationId);
    const riskEval = DestinationRiskService.evaluateDestination(cleanDest, orgPolicy);
    if (riskEval.classification === 'BLOCKED' || riskEval.isEmergency) {
      await TelecomSecurityAuditService.logSecurityEvent(supabase, {
        organizationId,
        userId,
        phoneNumber: fromNumber,
        destination: cleanDest,
        riskRule: riskEval.riskRule || (riskEval.isEmergency ? 'EMERGENCY_DESTINATION_GATE' : 'DESTINATION_RISK_BLOCKED'),
        operation: 'call_transfer',
        decision: 'blocked',
        reason: riskEval.reason,
        metadata: {
          countryCode: riskEval.countryCode,
        },
      });

      return {
        success: false,
        message: riskEval.reason,
      };
    }

    // 5. Telecom Suspension Check (User, Number, Org kill switches)
    const suspension = await TelecomSuspensionService.checkSuspension(supabase, {
      organizationId,
      userId,
      phoneNumber: fromNumber,
    });

    if (suspension.isSuspended) {
      await TelecomSecurityAuditService.logSecurityEvent(supabase, {
        organizationId,
        userId,
        phoneNumber: fromNumber,
        destination: cleanDest,
        riskRule: `TELECOM_SUSPENSION_${suspension.level}`,
        operation: 'call_transfer',
        decision: 'blocked',
        reason: suspension.reason || 'Telecom operation suspended.',
      });

      return {
        success: false,
        message: suspension.reason || 'Telecom access suspended.',
      };
    }

    const cleanDestDigits = cleanDest.replace(/\+/g, '');
    const transferDbCallId = params.transferOperationId || params.dbCallId || `transfer_${organizationId}_${params.callSid || 'active'}_${cleanDestDigits}`;

    // 6. Voice Velocity Controls (Phase 24C Distributed Atomic)
    const velocityCheck = await TelecomVelocityService.checkAndConsumeVoice(supabase as any, {
      organizationId,
      userId,
      serviceType: 'voice_outbound',
      destination: cleanDest,
      idempotencyKey: transferDbCallId,
    });

    if (!velocityCheck.allowed) {
      await TelecomSecurityAuditService.logSecurityEvent(supabase, {
        organizationId,
        userId,
        phoneNumber: fromNumber,
        destination: cleanDest,
        riskRule: velocityCheck.limitType?.toUpperCase() || 'VOICE_VELOCITY_EXCEEDED',
        operation: 'call_transfer',
        decision: 'throttled',
        reason: velocityCheck.reason || 'Voice call velocity throttled.',
      });

      return {
        success: false,
        message: velocityCheck.reason || 'Voice velocity limit exceeded. Please wait before transferring.',
      };
    }

    // 7. Verify organization wallet funding & resolve outbound rate card (voice_outbound, direction outbound, wholesale + 25%)
    try {
      const authResult = await VoiceAuthorizationService.authorizeOutboundVoice(supabase as any, {
        organizationId,
        dbCallId: transferDbCallId,
        userId,
        fromNumber,
        toNumber: cleanDest,
      });

      if (!authResult.authorized) {
        return {
          success: false,
          message: authResult.customerMessage || 'Rate resolution or wallet pre-authorization failed for external PSTN transfer leg.',
        };
      }
    } catch (walletErr: any) {
      return { success: false, message: walletErr.message || 'Wallet authorization failed for external PSTN leg.' };
    }

    // Record velocity attempt on successful authorization
    TelecomVelocityService.recordVoiceAttempt({
      organizationId,
      userId,
      serviceType: 'voice_outbound',
      destination: cleanDest,
    });

    return {
      success: true,
      normalizedNumber: cleanDest,
      message: `Call transferred to external number ${cleanDest}.`,
    };
  }
}
