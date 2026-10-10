import 'server-only';
import { SupabaseClient } from '@supabase/supabase-js';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { normalizeE164PhoneNumber } from '@/lib/utils';
import { VoiceAuthorizationService } from '@/lib/billing/telecom/voiceAuthorizationService';

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
   * Idempotent and race-safe.
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

    // 2. Fetch call record from DB if dbCallId or callSid provided
    let query = (supabase as any).from('calls').select('*').eq('organization_id', organizationId);
    if (dbCallId) {
      query = query.eq('id', dbCallId);
    } else if (callSid) {
      query = query.eq('twilio_call_sid', callSid);
    }

    const { data: callRecord } = await query.maybeSingle();

    const targetStatus = hold ? 'held' : 'connected';

    // 3. Update call status in database atomically
    if (callRecord) {
      await (supabase as any)
        .from('calls')
        .update({
          status: targetStatus,
          updated_at: new Date().toISOString(),
        })
        .eq('id', callRecord.id)
        .eq('organization_id', organizationId);
    }

    return {
      success: true,
      state: targetStatus,
      message: hold ? 'Call placed on hold.' : 'Call resumed.',
    };
  }

  /**
   * Transfers an active call to an internal team member (Blind Transfer).
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

    // 3. Update call record in database
    if (dbCallId || callSid) {
      let query = (supabase as any).from('calls').select('id').eq('organization_id', organizationId);
      if (dbCallId) query = query.eq('id', dbCallId);
      else query = query.eq('twilio_call_sid', callSid);

      const { data: callRow } = await query.maybeSingle();
      if (callRow) {
        await (supabase as any)
          .from('calls')
          .update({
            user_id: targetMember.id,
            status: 'transferred',
            updated_at: new Date().toISOString(),
          })
          .eq('id', callRow.id);
      }
    }

    return {
      success: true,
      targetMemberName: targetMember.full_name || targetMember.email,
      message: `Call transferred to ${targetMember.full_name || targetMember.email}.`,
    };
  }

  /**
   * Transfers an active call to an external PSTN phone number (External Transfer).
   * Enforces server-side rate verification (wholesale + 25%) and wallet reservation.
   */
  static async transferToExternalNumber(
    params: ExternalTransferParams,
    clientOverride?: SupabaseClient
  ): Promise<{ success: boolean; normalizedNumber?: string; message: string }> {
    const supabase = clientOverride || (await createServerSupabaseClient());
    const { organizationId, userId, externalNumber } = params;

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

    // 3. Resolve origination context from active call record
    let fromNumber = cleanDest;
    if (params.callSid || params.dbCallId) {
      let query = (supabase as any).from('calls').select('phone_number, from_number').eq('organization_id', organizationId);
      if (params.dbCallId) query = query.eq('id', params.dbCallId);
      else query = query.eq('twilio_call_sid', params.callSid);
      const { data: callRow } = await query.maybeSingle();
      if (callRow?.phone_number || callRow?.from_number) {
        fromNumber = callRow.phone_number || callRow.from_number;
      }
    }

    const cleanDestDigits = cleanDest.replace(/\+/g, '');
    const transferDbCallId = params.transferOperationId || params.dbCallId || `transfer_${organizationId}_${params.callSid || 'active'}_${cleanDestDigits}`;

    // 4. Verify organization wallet funding & resolve outbound rate card (voice_outbound, direction outbound, wholesale + 25%)
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

    return {
      success: true,
      normalizedNumber: cleanDest,
      message: `Call transferred to external number ${cleanDest}.`,
    };
  }
}
