import { SupabaseClient } from '@supabase/supabase-js';
import {
  TwilioCallControlAdapter,
  MockTwilioCallControlAdapter,
  ActiveCallTerminateResult,
} from '../../telephony/twilioCallControlAdapter';

export interface TerminateCallParams {
  organizationId: string;
  dbCallId: string;
  internalUsageId?: string;
  reason: string;
  providerAdapter?: TwilioCallControlAdapter;
  workerId?: string;
}

export interface TerminateCallResult {
  terminated: boolean;
  outcome: 'TERMINATED' | 'ALREADY_COMPLETED' | 'DEFINITELY_FAILED' | 'AMBIGUOUS_TIMEOUT';
  targetCallSid?: string;
  dbCallId: string;
  organizationId: string;
  errorDetails?: string;
}

export class ActiveCallTerminationService {
  /**
   * Server-authoritative automated safe termination dispatcher for telecom calls.
   * Target Topology Invariant: Outbound calls MUST target CHILD PSTN CallSid, NOT parent WebRTC CallSid.
   */
  public static async terminateActiveCall(
    client: SupabaseClient,
    params: TerminateCallParams
  ): Promise<TerminateCallResult> {
    const { organizationId, dbCallId, reason, workerId = `terminator_${Date.now()}` } = params;
    const adapter = params.providerAdapter || new MockTwilioCallControlAdapter();

    if (!organizationId || !dbCallId) {
      throw new Error('[ActiveCallTerminationService] Missing required parameters organizationId or dbCallId');
    }

    // 1. Fetch DB call record
    const { data: callRow, error: callErr } = await client
      .from('calls')
      .select('id, organization_id, twilio_call_sid, direction, status')
      .eq('id', dbCallId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (callErr || !callRow) {
      console.error(`[ActiveCallTerminationService] Call record query error: ${callErr?.message || 'NOT_FOUND'}`);
      return {
        terminated: false,
        outcome: 'DEFINITELY_FAILED',
        dbCallId,
        organizationId,
        errorDetails: 'CALL_RECORD_NOT_FOUND',
      };
    }

    // 2. CHECK ALREADY COMPLETED INVARIANT
    if (['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(callRow.status)) {
      console.log(`[ActiveCallTerminationService] Call ${dbCallId} is already in terminal state "${callRow.status}".`);
      return {
        terminated: true,
        outcome: 'ALREADY_COMPLETED',
        targetCallSid: callRow.twilio_call_sid || undefined,
        dbCallId,
        organizationId,
      };
    }

    // 3. RESOLVE CHILD VS PARENT CALLSID TOPOLOGY
    let targetCallSid = callRow.twilio_call_sid;

    // Check components table for child_provider_resource_id if outbound
    try {
      const internalUsageId = params.internalUsageId || `call:outbound:${dbCallId}`;
      const { data: comp } = await client
        .from('telecom_usage_components')
        .select('child_provider_resource_id, parent_provider_resource_id, leg_type')
        .eq('organization_id', organizationId)
        .eq('internal_usage_id', internalUsageId)
        .maybeSingle();

      if (comp) {
        if (callRow.direction === 'outbound' && comp.child_provider_resource_id) {
          targetCallSid = comp.child_provider_resource_id;
        } else if (callRow.direction === 'inbound' && comp.parent_provider_resource_id) {
          targetCallSid = comp.parent_provider_resource_id;
        }
      }
    } catch (compErr: any) {
      console.warn(`[ActiveCallTerminationService] Component lookup warning: ${compErr.message}`);
    }

    if (!targetCallSid || targetCallSid.trim().length === 0) {
      console.error(`[ActiveCallTerminationService] No valid target CallSid found for call ${dbCallId}`);
      return {
        terminated: false,
        outcome: 'DEFINITELY_FAILED',
        dbCallId,
        organizationId,
        errorDetails: 'MISSING_TARGET_CALL_SID',
      };
    }

    console.log(`[ActiveCallTerminationService] Dispatching automated termination for target ${targetCallSid} (reason: ${reason})...`);

    // 4. DISPATCH PROVIDER TERMINATION MUTATION
    let termResult: ActiveCallTerminateResult;
    try {
      termResult = await adapter.terminateActiveCall({
        callSid: targetCallSid,
        reason,
      });
    } catch (disErr: any) {
      console.warn(`[ActiveCallTerminationService] Exception during provider termination: ${disErr.message}`);
      termResult = {
        success: false,
        isMock: true,
        errorDetails: disErr.message,
      };
    }

    if (termResult.success) {
      const nowIso = new Date().toISOString();
      await client
        .from('calls')
        .update({
          status: 'completed',
          ended_at: nowIso,
          updated_at: nowIso,
        })
        .eq('id', dbCallId);

      return {
        terminated: true,
        outcome: 'TERMINATED',
        targetCallSid,
        dbCallId,
        organizationId,
      };
    }

    // 5. AMBIGUOUS / FAILED DISPATCH HANDLING
    return {
      terminated: false,
      outcome: 'AMBIGUOUS_TIMEOUT',
      targetCallSid,
      dbCallId,
      organizationId,
      errorDetails: termResult.errorDetails || 'PROVIDER_TERMINATION_FAILED',
    };
  }
}
