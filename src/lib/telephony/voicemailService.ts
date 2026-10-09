import { SupabaseClient } from '@supabase/supabase-js';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { hasEntitlement } from '@/lib/entitlements/server';
import { ProviderRecordingDeletionService } from './providerRecordingDeletionService';
import { RecordingPricingPolicyService } from '@/lib/billing/telecom/recordingPricingPolicyService';

export interface VoicemailDTO {
  id: string;
  organizationId: string;
  phoneNumberId: string | null;
  callId: string | null;
  providerCallSid: string;
  providerRecordingSid: string;
  callerNumber: string;
  calledNumber: string;
  recordingUrl: string;
  durationSeconds: number;
  status: 'completed' | 'failed' | 'deleted';
  storageModel: 'PROVIDER_MANAGED' | 'VOIPHUB_PRIVATE';
  providerDeletionStatus: 'active' | 'delete_requested' | 'provider_delete_pending' | 'provider_deleted' | 'delete_failed' | 'gated';
  providerDeletedAt: string | null;
  isRead: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  calledPhoneFriendlyName?: string | null;
}

export interface ListVoicemailsResult {
  success: boolean;
  message?: string;
  voicemails: VoicemailDTO[];
  unreadCount: number;
  totalCount: number;
  page: number;
  limit: number;
}

export class VoicemailService {
  /**
   * Checks whether the organization is entitled to use voicemail features.
   */
  static async isEntitled(clientOverride?: SupabaseClient): Promise<boolean> {
    return await hasEntitlement('voicemail', clientOverride);
  }

  /**
   * Lists voicemails for an organization with pagination and unread counts.
   */
  static async listVoicemails(
    organizationId: string,
    options: { page?: number; limit?: number; isRead?: boolean } = {},
    clientOverride?: SupabaseClient
  ): Promise<ListVoicemailsResult> {
    const supabase = clientOverride || (await createServerSupabaseClient());
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 20));
    const offset = (page - 1) * limit;

    // Check entitlement first
    const entitled = await this.isEntitled(supabase);
    if (!entitled) {
      return {
        success: false,
        message: 'Voicemail feature is not enabled for your subscription plan.',
        voicemails: [],
        unreadCount: 0,
        totalCount: 0,
        page,
        limit,
      };
    }

    // Unread count for organization
    const { count: unreadCount } = await (supabase as any)
      .from('voicemails')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .eq('is_read', false)
      .is('deleted_at', null);

    // Total count
    let countQuery = (supabase as any)
      .from('voicemails')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .is('deleted_at', null);

    if (typeof options.isRead === 'boolean') {
      countQuery = countQuery.eq('is_read', options.isRead);
    }

    const { count: totalCount } = await countQuery;

    // Fetch records page
    let query = (supabase as any)
      .from('voicemails')
      .select(`
        id,
        organization_id,
        phone_number_id,
        call_id,
        provider_call_sid,
        provider_recording_sid,
        caller_number,
        called_number,
        recording_url,
        duration_seconds,
        status,
        storage_model,
        provider_deletion_status,
        provider_deleted_at,
        is_read,
        created_at,
        updated_at,
        deleted_at,
        phone_numbers ( friendly_name )
      `)
      .eq('organization_id', organizationId)
      .is('deleted_at', null);

    if (typeof options.isRead === 'boolean') {
      query = query.eq('is_read', options.isRead);
    }

    const { data: records, error } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error('[VoicemailService.listVoicemails] Error:', error.message);
      return {
        success: false,
        message: `Failed to fetch voicemails: ${error.message}`,
        voicemails: [],
        unreadCount: unreadCount || 0,
        totalCount: totalCount || 0,
        page,
        limit,
      };
    }

    const voicemails: VoicemailDTO[] = (records || []).map((row: any) => ({
      id: row.id,
      organizationId: row.organization_id,
      phoneNumberId: row.phone_number_id,
      callId: row.call_id,
      providerCallSid: row.provider_call_sid,
      providerRecordingSid: row.provider_recording_sid,
      callerNumber: row.caller_number,
      calledNumber: row.called_number,
      recordingUrl: row.recording_url,
      durationSeconds: row.duration_seconds || 0,
      status: row.status,
      storageModel: row.storage_model || 'PROVIDER_MANAGED',
      providerDeletionStatus: row.provider_deletion_status || 'active',
      providerDeletedAt: row.provider_deleted_at || null,
      isRead: Boolean(row.is_read),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
      calledPhoneFriendlyName: row.phone_numbers?.friendly_name || null,
    }));

    return {
      success: true,
      voicemails,
      unreadCount: unreadCount || 0,
      totalCount: totalCount || 0,
      page,
      limit,
    };
  }

  /**
   * Fetches a single voicemail by ID with strict tenant isolation.
   */
  static async getVoicemailById(
    organizationId: string,
    voicemailId: string,
    clientOverride?: SupabaseClient
  ): Promise<VoicemailDTO | null> {
    const supabase = clientOverride || (await createServerSupabaseClient());

    const { data: row } = await (supabase as any)
      .from('voicemails')
      .select(`
        id,
        organization_id,
        phone_number_id,
        call_id,
        provider_call_sid,
        provider_recording_sid,
        caller_number,
        called_number,
        recording_url,
        duration_seconds,
        status,
        storage_model,
        provider_deletion_status,
        provider_deleted_at,
        is_read,
        created_at,
        updated_at,
        deleted_at,
        phone_numbers ( friendly_name )
      `)
      .eq('id', voicemailId)
      .eq('organization_id', organizationId)
      .is('deleted_at', null)
      .maybeSingle();

    if (!row) return null;

    return {
      id: row.id,
      organizationId: row.organization_id,
      phoneNumberId: row.phone_number_id,
      callId: row.call_id,
      providerCallSid: row.provider_call_sid,
      providerRecordingSid: row.provider_recording_sid,
      callerNumber: row.caller_number,
      calledNumber: row.called_number,
      recordingUrl: row.recording_url,
      durationSeconds: row.duration_seconds || 0,
      status: row.status,
      storageModel: row.storage_model || 'PROVIDER_MANAGED',
      providerDeletionStatus: row.provider_deletion_status || 'active',
      providerDeletedAt: row.provider_deleted_at || null,
      isRead: Boolean(row.is_read),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
      calledPhoneFriendlyName: row.phone_numbers?.friendly_name || null,
    };
  }

  /**
   * Updates the is_read status of a voicemail.
   */
  static async markAsRead(
    organizationId: string,
    voicemailId: string,
    isRead: boolean,
    clientOverride?: SupabaseClient
  ): Promise<{ success: boolean; message?: string }> {
    const supabase = clientOverride || (await createServerSupabaseClient());

    const { error } = await (supabase as any)
      .from('voicemails')
      .update({
        is_read: isRead,
        updated_at: new Date().toISOString(),
      })
      .eq('id', voicemailId)
      .eq('organization_id', organizationId)
      .is('deleted_at', null);

    if (error) {
      return { success: false, message: `Failed to update voicemail read state: ${error.message}` };
    }

    return { success: true };
  }

  /**
   * Durable server-side provider-synchronized deletion for an organization's voicemail.
   */
  static async softDeleteVoicemail(
    organizationId: string,
    voicemailId: string,
    clientOverride?: SupabaseClient
  ): Promise<{ success: boolean; message?: string; status?: string }> {
    const supabase = clientOverride || (await createServerSupabaseClient());
    const result = await ProviderRecordingDeletionService.requestVoicemailDeletion(
      supabase,
      organizationId,
      voicemailId
    );
    return {
      success: result.success,
      message: result.message,
      status: result.status,
    };
  }

  /**
   * Idempotently persists a recorded voicemail from provider callback.
   * Also calculates recording cost and records immutable financial snapshot.
   */
  static async recordVoicemail(
    data: {
      organizationId: string;
      phoneNumberId?: string | null;
      callId?: string | null;
      providerCallSid: string;
      providerRecordingSid: string;
      callerNumber: string;
      calledNumber: string;
      recordingUrl: string;
      durationSeconds: number;
      providerUnitCostMicro?: bigint;
    },
    clientOverride?: SupabaseClient
  ): Promise<{ success: boolean; message?: string; voicemailId?: string }> {
    const supabase = clientOverride || (await createServerSupabaseClient());

    // 0-length recording check
    if (data.durationSeconds <= 0) {
      return { success: false, message: 'Zero-length recording ignored.' };
    }

    // Idempotency check: provider_recording_sid
    const { data: existing } = await (supabase as any)
      .from('voicemails')
      .select('id')
      .eq('provider_recording_sid', data.providerRecordingSid)
      .maybeSingle();

    if (existing) {
      console.log(`[VoicemailService] Duplicate callback for RecordingSid "${data.providerRecordingSid}". Skipping creation.`);
      return { success: true, message: 'Voicemail already recorded.', voicemailId: existing.id };
    }

    let recordingUrl = data.recordingUrl;
    if (recordingUrl && !recordingUrl.endsWith('.mp3') && !recordingUrl.endsWith('.wav')) {
      recordingUrl = `${recordingUrl}.mp3`;
    }

    const { data: created, error } = await (supabase as any)
      .from('voicemails')
      .insert({
        organization_id: data.organizationId,
        phone_number_id: data.phoneNumberId || null,
        call_id: data.callId || null,
        provider_call_sid: data.providerCallSid,
        provider_recording_sid: data.providerRecordingSid,
        caller_number: data.callerNumber,
        called_number: data.calledNumber,
        recording_url: recordingUrl,
        duration_seconds: data.durationSeconds,
        status: 'completed',
        storage_model: 'PROVIDER_MANAGED',
        provider_deletion_status: 'active',
        is_read: false,
      })
      .select('id')
      .single();

    if (error) {
      console.error('[VoicemailService.recordVoicemail] Insert error:', error.message);
      return { success: false, message: `Failed to persist voicemail: ${error.message}` };
    }

    // Financial Snapshot Creation
    try {
      const policy = await RecordingPricingPolicyService.resolvePolicy(supabase, 'recording_capture');
      const unitCostMicro = data.providerUnitCostMicro ?? BigInt(2500); // Reference AU rate: $0.0025/min = 2500 micro-units

      const pricingCalc = RecordingPricingPolicyService.calculateRecordingCost({
        providerUnitCostMicro: unitCostMicro,
        durationSeconds: data.durationSeconds,
        markupBps: policy.markupBps,
        policyKey: policy.policyKey,
        policyVersion: policy.version,
      });

      const idempotencyKey = `idemp_rec_snap_${data.providerRecordingSid}`;
      await RecordingPricingPolicyService.recordFinancialSnapshot(supabase, {
        organizationId: data.organizationId,
        callId: data.callId || null,
        voicemailId: created.id,
        provider: 'twilio',
        providerRecordingSid: data.providerRecordingSid,
        durationSeconds: data.durationSeconds,
        providerUnitCostMicro: pricingCalc.providerUnitCostMicro,
        providerCalculatedCostMicro: pricingCalc.providerCalculatedCostMicro,
        markupBps: pricingCalc.markupBps,
        customerCalculatedCostMicro: pricingCalc.customerCalculatedCostMicro,
        customerRetailChargeMinor: pricingCalc.customerRetailChargeMinor,
        currency: pricingCalc.currency,
        pricingPolicyKey: pricingCalc.policyKey,
        pricingPolicyVersion: pricingCalc.policyVersion,
        settlementStatus: 'settled',
        idempotencyKey,
      });
    } catch (pricingErr: any) {
      console.warn('[VoicemailService] Pricing snapshot warning:', pricingErr.message || pricingErr);
    }

    return { success: true, voicemailId: created.id };
  }
}
