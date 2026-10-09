import { SupabaseClient } from '@supabase/supabase-js';

export interface ProviderDeletionResult {
  success: boolean;
  status: 'provider_deleted' | 'gated' | 'delete_failed' | 'already_deleted';
  message?: string;
  operationId?: string;
}

export class ProviderRecordingDeletionService {
  /**
   * Executes or queues a server-side durable provider deletion operation.
   * Checks ENABLE_PROVIDER_RECORDING_DELETE_MUTATION feature gate (default OFF).
   */
  public static async requestVoicemailDeletion(
    client: SupabaseClient,
    organizationId: string,
    voicemailId: string
  ): Promise<ProviderDeletionResult> {
    // 1. Fetch voicemail and verify organization ownership & status
    const { data: voicemail, error: vmError } = await (client as any)
      .from('voicemails')
      .select('id, organization_id, provider_recording_sid, status, deleted_at')
      .eq('id', voicemailId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (vmError || !voicemail) {
      return {
        success: false,
        status: 'delete_failed',
        message: 'Voicemail not found or access denied across tenants.',
      };
    }

    const providerRecordingSid = voicemail.provider_recording_sid;

    // 2. Soft-delete local voicemail immediately
    const nowIso = new Date().toISOString();
    await (client as any)
      .from('voicemails')
      .update({
        status: 'deleted',
        deleted_at: voicemail.deleted_at || nowIso,
        provider_deletion_status: 'delete_requested',
        updated_at: nowIso,
      })
      .eq('id', voicemailId)
      .eq('organization_id', organizationId);

    // 3. Create/upsert durable provider deletion operation record
    let operationId: string | undefined;
    try {
      const { data: opRecord } = await (client as any)
        .from('provider_recording_deletion_operations')
        .upsert(
          {
            organization_id: organizationId,
            voicemail_id: voicemailId,
            provider_recording_sid: providerRecordingSid,
            status: 'pending',
            updated_at: nowIso,
          },
          { onConflict: 'voicemail_id' }
        )
        .select('id')
        .maybeSingle();
      operationId = opRecord?.id;
    } catch {
      // Table may not exist yet in local mock test
    }

    // 4. Check Provider Mutation Gate (DEFAULT IS OFF)
    const isGateEnabled = process.env.ENABLE_PROVIDER_RECORDING_DELETE_MUTATION === 'true';

    if (!isGateEnabled) {
      // Feature gate is OFF (default)
      try {
        await (client as any)
          .from('provider_recording_deletion_operations')
          .update({
            status: 'gated',
            last_error: 'ENABLE_PROVIDER_RECORDING_DELETE_MUTATION gate is OFF.',
            updated_at: new Date().toISOString(),
          })
          .eq('voicemail_id', voicemailId);
      } catch {
        // Table fallback
      }

      await (client as any)
        .from('voicemails')
        .update({
          provider_deletion_status: 'gated',
          updated_at: new Date().toISOString(),
        })
        .eq('id', voicemailId);

      return {
        success: true,
        status: 'gated',
        message: 'Voicemail soft-deleted locally. Provider API mutation gate is OFF (safe mode).',
        operationId,
      };
    }

    // 5. Gate is ON -> Execute Twilio API DELETE call server-side
    return await this.executeTwilioRecordingDeletion(client, voicemailId, providerRecordingSid, operationId);
  }

  /**
   * Performs server-side Twilio DELETE recording API call.
   */
  private static async executeTwilioRecordingDeletion(
    client: SupabaseClient,
    voicemailId: string,
    recordingSid: string,
    operationId?: string
  ): Promise<ProviderDeletionResult> {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    if (!accountSid || !authToken) {
      const errMsg = 'Twilio credentials missing for provider deletion mutation.';
      await this.updateOperationStatus(client, voicemailId, 'delete_failed', errMsg);
      return { success: false, status: 'delete_failed', message: errMsg, operationId };
    }

    try {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${recordingSid}.json`;
      const authHeader = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;

      const res = await fetch(url, {
        method: 'DELETE',
        headers: {
          Authorization: authHeader,
        },
      });

      if (res.status === 204 || res.status === 200 || res.status === 404) {
        // 204/200 = successfully deleted, 404 = already deleted on Twilio
        const finalStatus = res.status === 404 ? 'already_deleted' : 'provider_deleted';
        await (client as any)
          .from('provider_recording_deletion_operations')
          .update({
            status: 'provider_deleted',
            last_error: res.status === 404 ? 'Twilio returned 404 (already deleted).' : null,
            updated_at: new Date().toISOString(),
          })
          .eq('voicemail_id', voicemailId);

        await (client as any)
          .from('voicemails')
          .update({
            provider_deletion_status: 'provider_deleted',
            provider_deleted_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', voicemailId);

        return {
          success: true,
          status: finalStatus,
          message: 'Provider recording deleted successfully.',
          operationId,
        };
      } else {
        const errorText = await res.text();
        const errMsg = `Twilio API deletion error ${res.status}: ${errorText}`;
        await this.updateOperationStatus(client, voicemailId, 'delete_failed', errMsg);
        return { success: false, status: 'delete_failed', message: errMsg, operationId };
      }
    } catch (err: any) {
      const errMsg = `Exception during provider deletion: ${err.message || err}`;
      await this.updateOperationStatus(client, voicemailId, 'delete_failed', errMsg);
      return { success: false, status: 'delete_failed', message: errMsg, operationId };
    }
  }

  private static async updateOperationStatus(
    client: SupabaseClient,
    voicemailId: string,
    status: string,
    errorMsg: string
  ) {
    try {
      await (client as any)
        .from('provider_recording_deletion_operations')
        .update({
          status,
          last_error: errorMsg,
          updated_at: new Date().toISOString(),
        })
        .eq('voicemail_id', voicemailId);
    } catch {
      // Ignore missing table fallback
    }

    await (client as any)
      .from('voicemails')
      .update({
        provider_deletion_status: status,
        updated_at: new Date().toISOString(),
      })
      .eq('id', voicemailId);
  }
}
