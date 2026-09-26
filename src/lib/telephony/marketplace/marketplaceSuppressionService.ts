import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';

export interface SuppressionQueryResult {
  success: boolean;
  suppressedSet: Set<string>;
  error?: string;
}

/**
 * Server-side Marketplace Suppression Service.
 * Evaluates platform-global phone number suppression based on:
 * 1. public.phone_numbers (active, inactive, suspended lifecycle statuses)
 * 2. public.provider_number_operations (pending, in_progress, reconciliation_required, manual_review_required purchase locks)
 *
 * Enforces platform-global suppression across all tenants without leaking organization or operation metadata.
 * Fails closed safely if suppression lookup fails.
 */
export class MarketplaceSuppressionService {
  /**
   * Retrieves the set of E.164 phone numbers that must be suppressed from marketplace inventory searches.
   * Option to filter check to specific input E.164 candidate numbers for query optimization.
   */
  static async getSuppressedPhoneNumbers(
    candidateE164s?: string[]
  ): Promise<SuppressionQueryResult> {
    try {
      const supabase = createAdminClient();
      const suppressedSet = new Set<string>();

      // 1. Query active lifecycle-owned numbers on public.phone_numbers (Platform-Global)
      let phoneQuery = (supabase as any)
        .from('phone_numbers')
        .select('phone_number')
        .in('status', ['active', 'inactive', 'suspended']);

      if (candidateE164s && candidateE164s.length > 0) {
        phoneQuery = phoneQuery.in('phone_number', candidateE164s);
      }

      const { data: ownedData, error: ownedErr } = await phoneQuery;

      if (ownedErr) {
        console.error('[MarketplaceSuppressionService] Error querying owned phone_numbers:', ownedErr);
        return {
          success: false,
          suppressedSet: new Set(),
          error: 'Suppression lookup failed on owned numbers database query.',
        };
      }

      if (ownedData) {
        for (const row of ownedData) {
          if (row.phone_number) {
            suppressedSet.add(row.phone_number.trim());
          }
        }
      }

      // 2. Query active purchase operation locks on public.provider_number_operations (Platform-Global)
      let opQuery = (supabase as any)
        .from('provider_number_operations')
        .select('phone_number_e164')
        .eq('operation_type', 'purchase_number')
        .in('status', [
          'pending',
          'in_progress',
          'reconciliation_required',
          'manual_review_required',
        ]);

      if (candidateE164s && candidateE164s.length > 0) {
        opQuery = opQuery.in('phone_number_e164', candidateE164s);
      }

      const { data: lockedData, error: lockedErr } = await opQuery;

      if (lockedErr) {
        console.error('[MarketplaceSuppressionService] Error querying purchase operation locks:', lockedErr);
        return {
          success: false,
          suppressedSet: new Set(),
          error: 'Suppression lookup failed on active operation locks database query.',
        };
      }

      if (lockedData) {
        for (const row of lockedData) {
          if (row.phone_number_e164) {
            suppressedSet.add(row.phone_number_e164.trim());
          }
        }
      }

      return {
        success: true,
        suppressedSet,
      };
    } catch (err: any) {
      console.error('[MarketplaceSuppressionService] Exception during suppression calculation:', err.message || err);
      return {
        success: false,
        suppressedSet: new Set(),
        error: `Suppression service exception: ${err.message || err}`,
      };
    }
  }
}
