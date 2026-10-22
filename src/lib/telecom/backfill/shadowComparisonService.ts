/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';
import { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  ShadowComparisonDivergence,
  ShadowComparisonReport,
} from './types';

export class ShadowComparisonService {
  constructor(private readonly clientOverride?: SupabaseClient | any) {}

  private getClient(): SupabaseClient | any {
    return this.clientOverride || createAdminClient();
  }

  /**
   * TASK 25: SHADOW READ COMPARISON
   * Compares the legacy view of phone numbers with the canonical Phase 23 projection.
   * Compares semantics, not raw column equality.
   */
  async compareOrganizationNumbers(organizationId: string): Promise<ShadowComparisonReport> {
    const supabase = this.getClient();

    // 1. Fetch phone numbers
    const { data: numbers, error } = await (supabase as any)
      .from('phone_numbers')
      .select('*')
      .eq('organization_id', organizationId);

    if (error) {
      throw new Error(`Shadow comparison fetch error: ${error.message}`);
    }

    const divergences: ShadowComparisonDivergence[] = [];
    let exactMatches = 0;

    for (const phone of numbers || []) {
      const e164 = phone.phone_number || phone.phone_number_e164;

      // Check Lifecycle Semantic Match
      const legacyStatus = (phone.status || '').toLowerCase();
      const canonicalOwnership = phone.ownership_state;
      const canonicalService = phone.service_state;

      let lifecycleMatches = true;
      if (canonicalOwnership === 'OWNED') {
        if (legacyStatus !== 'active' && legacyStatus !== 'suspended' && legacyStatus !== 'grace_period') {
          lifecycleMatches = false;
        }
      } else if (canonicalOwnership === 'RELEASED') {
        if (legacyStatus !== 'released') {
          lifecycleMatches = false;
        }
      } else if (canonicalOwnership === 'PORTED_OUT') {
        if (legacyStatus !== 'ported_out') {
          lifecycleMatches = false;
        }
      }

      if (!lifecycleMatches) {
        divergences.push({
          phoneNumberId: phone.id,
          phoneNumberE164: e164,
          organizationId,
          dimension: 'LIFECYCLE',
          legacyValue: { status: phone.status, active: phone.active },
          canonicalValue: { ownership_state: canonicalOwnership, service_state: canonicalService },
          severity: 'CRITICAL',
          description: `Lifecycle divergence: Canonical is '${canonicalOwnership}/${canonicalService}' but legacy status is '${phone.status}'.`,
        });
      }

      // Check Assignment Semantic Match
      const { data: legacyAssignments } = await (supabase as any)
        .from('user_phone_assignments')
        .select('user_id')
        .eq('phone_number_id', phone.id);

      const legacyAssignedUserId = legacyAssignments && legacyAssignments[0]?.user_id;
      if (phone.assignment_target_type === 'USER' && phone.assignment_target_id) {
        if (legacyAssignedUserId && legacyAssignedUserId !== phone.assignment_target_id) {
          divergences.push({
            phoneNumberId: phone.id,
            phoneNumberE164: e164,
            organizationId,
            dimension: 'ASSIGNMENT',
            legacyValue: { assigned_user_id: legacyAssignedUserId },
            canonicalValue: { target_type: 'USER', target_id: phone.assignment_target_id },
            severity: 'CRITICAL',
            description: `Assignment divergence: Canonical target is user ${phone.assignment_target_id} but legacy maps to ${legacyAssignedUserId}.`,
          });
        }
      }

      if (lifecycleMatches && divergences.filter((d) => d.phoneNumberId === phone.id).length === 0) {
        exactMatches++;
      }
    }

    return {
      totalInspected: (numbers || []).length,
      exactMatches,
      divergencesFound: divergences.length,
      divergences,
    };
  }
}
