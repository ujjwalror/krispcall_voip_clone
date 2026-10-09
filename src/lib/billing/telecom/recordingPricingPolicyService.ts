import { SupabaseClient } from '@supabase/supabase-js';

export interface RecordingPricingPolicy {
  id?: string;
  policyKey: string;
  provider: string;
  usageType: 'recording_capture' | 'recording_storage';
  markupBps: number;
  version: number;
  status: 'active' | 'deprecated';
  effectiveFrom: string;
  effectiveTo?: string | null;
  createdAt?: string;
}

export interface RecordingCostCalculationResult {
  providerUnitCostMicro: bigint;
  durationSeconds: number;
  providerCalculatedCostMicro: bigint;
  markupBps: number;
  customerCalculatedCostMicro: bigint;
  customerRetailChargeMinor: number;
  policyKey: string;
  policyVersion: number;
  currency: string;
}

export interface RecordingFinancialSnapshot {
  id?: string;
  organizationId: string;
  callId?: string | null;
  voicemailId?: string | null;
  provider: string;
  providerRecordingSid: string;
  durationSeconds: number;
  providerUnitCostMicro: bigint;
  providerCalculatedCostMicro: bigint;
  markupBps: number;
  customerCalculatedCostMicro: bigint;
  customerRetailChargeMinor: number;
  currency: string;
  pricingPolicyKey: string;
  pricingPolicyVersion: number;
  settlementStatus: 'settled' | 'failed_closed' | 'pending';
  idempotencyKey: string;
}

export class RecordingPricingPolicyService {
  public static DEFAULT_MARKUP_BPS = 1000; // 10%

  /**
   * Resolves active recording pricing policy for usage type.
   */
  public static async resolvePolicy(
    client?: SupabaseClient,
    usageType: 'recording_capture' | 'recording_storage' = 'recording_capture'
  ): Promise<RecordingPricingPolicy> {
    const defaultPolicy: RecordingPricingPolicy = {
      policyKey: `default_twilio_${usageType}_v1`,
      provider: 'twilio',
      usageType,
      markupBps: this.DEFAULT_MARKUP_BPS,
      version: 1,
      status: 'active',
      effectiveFrom: new Date().toISOString(),
    };

    if (!client) return defaultPolicy;

    try {
      const { data, error } = await (client as any)
        .from('voicemail_recording_pricing_policies')
        .select('*')
        .eq('provider', 'twilio')
        .eq('usage_type', usageType)
        .eq('status', 'active')
        .order('version', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error || !data) return defaultPolicy;

      return {
        id: data.id,
        policyKey: data.policy_key,
        provider: data.provider,
        usageType: data.usage_type,
        markupBps: Number(data.markup_bps || 1000),
        version: Number(data.version || 1),
        status: data.status,
        effectiveFrom: data.effective_from,
        effectiveTo: data.effective_to,
        createdAt: data.created_at,
      };
    } catch {
      return defaultPolicy;
    }
  }

  /**
   * High-precision calculation of recording cost using BigInt micro-units (1 cent = 10,000 micro-units).
   * Formula: customer_recording_cost = provider_recording_cost * (1 + markup_bps / 10000)
   */
  public static calculateRecordingCost(params: {
    providerUnitCostMicro: bigint;
    durationSeconds: number;
    markupBps: number;
    policyKey?: string;
    policyVersion?: number;
    currency?: string;
  }): RecordingCostCalculationResult {
    const {
      providerUnitCostMicro,
      durationSeconds,
      markupBps,
      policyKey = 'default_twilio_recording_capture_v1',
      policyVersion = 1,
      currency = 'USD',
    } = params;

    const durationBig = BigInt(Math.max(0, durationSeconds));

    // Provider cost micro = (providerUnitCostMicro * durationSeconds + 59) / 60
    const providerCalculatedCostMicro = (providerUnitCostMicro * durationBig + BigInt(59)) / BigInt(60);

    // Customer cost micro = providerCalculatedCostMicro * (1 + markupBps / 10000)
    // Ceiling division: (providerCost * (10000 + markupBps) + 9999) / 10000
    const bpsBig = BigInt(Math.max(0, markupBps));
    const customerCalculatedCostMicro =
      (providerCalculatedCostMicro * (BigInt(10000) + bpsBig) + BigInt(9999)) / BigInt(10000);

    // Minor units (cents): 1 cent = 10,000 micro-units
    // Ceiling division for minor cents: (customerCalculatedCostMicro + 9999) / 10000
    const customerRetailChargeMinor = Number(
      (customerCalculatedCostMicro + BigInt(9999)) / BigInt(10000)
    );

    return {
      providerUnitCostMicro,
      durationSeconds,
      providerCalculatedCostMicro,
      markupBps,
      customerCalculatedCostMicro,
      customerRetailChargeMinor,
      policyKey,
      policyVersion,
      currency,
    };
  }

  /**
   * Persists an immutable financial snapshot of recording usage.
   * Enforces idempotency via idempotencyKey.
   */
  public static async recordFinancialSnapshot(
    client: SupabaseClient,
    snapshot: RecordingFinancialSnapshot
  ): Promise<{ success: boolean; id?: string; message?: string }> {
    try {
      // Idempotency check
      const { data: existing } = await (client as any)
        .from('voicemail_recording_usage_snapshots')
        .select('id')
        .eq('idempotency_key', snapshot.idempotencyKey)
        .maybeSingle();

      if (existing) {
        return { success: true, id: existing.id, message: 'Snapshot already exists (idempotent).' };
      }

      const { data, error } = await (client as any)
        .from('voicemail_recording_usage_snapshots')
        .insert({
          organization_id: snapshot.organizationId,
          call_id: snapshot.callId || null,
          voicemail_id: snapshot.voicemailId || null,
          provider: snapshot.provider,
          provider_recording_sid: snapshot.providerRecordingSid,
          duration_seconds: snapshot.durationSeconds,
          provider_unit_cost_micro: snapshot.providerUnitCostMicro.toString(),
          provider_calculated_cost_micro: snapshot.providerCalculatedCostMicro.toString(),
          markup_bps: snapshot.markupBps,
          customer_calculated_cost_micro: snapshot.customerCalculatedCostMicro.toString(),
          customer_retail_charge_minor: snapshot.customerRetailChargeMinor,
          currency: snapshot.currency,
          pricing_policy_key: snapshot.pricingPolicyKey,
          pricing_policy_version: snapshot.pricingPolicyVersion,
          settlement_status: snapshot.settlementStatus,
          idempotency_key: snapshot.idempotencyKey,
        })
        .select('id')
        .single();

      if (error) {
        return { success: false, message: `Failed to record financial snapshot: ${error.message}` };
      }

      return { success: true, id: data.id };
    } catch (err: any) {
      return { success: false, message: `Exception recording snapshot: ${err.message || err}` };
    }
  }
}
