import { SupabaseClient } from '@supabase/supabase-js';
import { CreditEntryType, CreditLedgerEntry, CreditReferenceType } from './types';

export interface AddCreditEntryParams {
  organizationId: string;
  entryType: CreditEntryType;
  amountMinor: number;
  currency?: string;
  description: string;
  referenceType?: CreditReferenceType | null;
  referenceId?: string | null;
  createdBy?: string | null;
}

export class CreditLedgerService {
  /**
   * Appends an immutable credit ledger record and calculates the new running balance.
   */
  static async addCreditEntry(
    supabase: SupabaseClient,
    params: AddCreditEntryParams
  ): Promise<CreditLedgerEntry> {
    const {
      organizationId,
      entryType,
      amountMinor,
      currency = 'USD',
      description,
      referenceType = null,
      referenceId = null,
      createdBy = null,
    } = params;

    if (!organizationId) {
      throw new Error('CreditLedgerService: organizationId is required.');
    }

    if (!description || description.trim().length === 0) {
      throw new Error('CreditLedgerService: description is required.');
    }

    if (!Number.isInteger(amountMinor) || amountMinor === 0) {
      throw new Error('CreditLedgerService: amountMinor must be a non-zero integer.');
    }

    // Validate sign against entryType
    if ((entryType === 'grant' || entryType === 'adjustment') && amountMinor < 0) {
      throw new Error(`CreditLedgerService: amountMinor for '${entryType}' must be positive.`);
    }
    if ((entryType === 'consumption' || entryType === 'expiration') && amountMinor > 0) {
      throw new Error(`CreditLedgerService: amountMinor for '${entryType}' must be negative.`);
    }

    // 1. Execute database-level atomic credit consumption RPC (FOR UPDATE serialized)
    const { data: newEntry, error: rpcErr } = await (supabase as any).rpc(
      'record_credit_ledger_entry_atomic',
      {
        p_organization_id: organizationId,
        p_entry_type: entryType,
        p_amount_minor: amountMinor,
        p_currency: currency,
        p_description: description.trim(),
        p_reference_type: referenceType,
        p_reference_id: referenceId,
        p_created_by: createdBy,
      }
    );

    if (rpcErr) {
      console.error('[CreditLedgerService] Atomic RPC error:', rpcErr.message);
      if (rpcErr.message.includes('INSUFFICIENT_CREDIT')) {
        throw new Error(
          `INSUFFICIENT_CREDIT: Credit consumption exceeds available organization balance.`
        );
      }
      throw new Error(`CreditLedgerService error: ${rpcErr.message}`);
    }

    return {
      id: newEntry.id,
      organizationId: newEntry.organization_id,
      entryType: newEntry.entry_type,
      amountMinor: Number(newEntry.amount_minor),
      balanceAfterMinor: Number(newEntry.balance_after_minor),
      currency: newEntry.currency,
      description: newEntry.description,
      referenceType: newEntry.reference_type,
      referenceId: newEntry.reference_id,
      createdBy: newEntry.created_by,
      createdAt: newEntry.created_at,
    };
  }

  /**
   * Fetches the authoritative running balance for an organization from the latest ledger record.
   */
  static async getCreditBalanceMinor(
    supabase: SupabaseClient,
    organizationId: string
  ): Promise<number> {
    const { data, error } = await (supabase as any)
      .from('billing_credit_ledger')
      .select('balance_after_minor')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('[CreditLedgerService] Error reading credit balance:', error.message);
      throw new Error(`CreditLedgerService error: ${error.message}`);
    }

    return data ? Number(data.balance_after_minor) : 0;
  }
}
