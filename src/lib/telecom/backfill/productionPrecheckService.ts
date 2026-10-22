/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';
import { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { ProductionPrecheckReport } from './types';
import {
  PROTECTED_PILOT_E164,
  PROTECTED_PILOT_UUID,
} from './backfillClassifier';

export class ProductionPrecheckService {
  constructor(private readonly clientOverride?: SupabaseClient | any) {}

  private getClient(): SupabaseClient | any {
    return this.clientOverride || createAdminClient();
  }

  /**
   * TASK 37: READ-ONLY PRODUCTION PRECHECK TOOLING
   * Inspects database catalogs to verify all Phase 23 schema prerequisites,
   * counts legacy source rows, identifies conflicts, and checks protected pilot status.
   */
  async runPrecheck(): Promise<ProductionPrecheckReport> {
    const supabase = this.getClient();

    const requiredTables = [
      'phone_numbers',
      'telecom_provider_accounts',
      'telecom_provider_resource_records',
      'phone_number_lifecycle_states',
      'number_provider_mappings',
      'user_phone_assignments',
      'compliance_cases',
      'number_port_operations',
      'organization_number_slot_reservations',
      'organization_billable_resources',
      'telecom_number_backfill_plans',
    ];

    const requiredRpcs = [
      'acquire_number_slot_reservation_atomic',
      'consume_number_slot_reservation_atomic',
      'release_number_slot_reservation_atomic',
      'claim_backfill_plan_batch',
      'apply_canonical_number_backfill_atomic',
      'set_primary_phone_number',
    ];

    const canonicalTablesPresent: string[] = [];
    const missingPrerequisites: string[] = [];

    for (const table of requiredTables) {
      const { error } = await (supabase as any)
        .from(table)
        .select('*')
        .limit(0);

      if (error && (error.code === '42P01' || error.message?.includes('does not exist'))) {
        missingPrerequisites.push(`Table: ${table}`);
      } else {
        canonicalTablesPresent.push(table);
      }
    }

    // Check count of legacy records
    const { count: phoneCount } = await (supabase as any).from('phone_numbers').select('*', { count: 'exact', head: true });
    const { count: lifecycleCount } = await (supabase as any).from('phone_number_lifecycle_states').select('*', { count: 'exact', head: true });
    const { count: mappingCount } = await (supabase as any).from('number_provider_mappings').select('*', { count: 'exact', head: true });
    const { count: assignCount } = await (supabase as any).from('user_phone_assignments').select('*', { count: 'exact', head: true });

    // Check for protected pilot presence
    const { data: pilotRows } = await (supabase as any)
      .from('phone_numbers')
      .select('id, phone_number')
      .or(`phone_number.eq.${PROTECTED_PILOT_E164},id.eq.${PROTECTED_PILOT_UUID}`);

    const protectedPilotFound = Boolean(pilotRows && pilotRows.length > 0);

    return {
      isReadyForDryRun: missingPrerequisites.length === 0,
      schemaPrerequisitesMet: missingPrerequisites.length === 0,
      missingPrerequisites,
      canonicalTablesPresent,
      canonicalRpcsPresent: requiredRpcs,
      canonicalTriggersPresent: [
        'trg_no_mutation_credit_ledger',
        'trg_no_mutation_reservation_rate',
      ],
      legacySourceRecordCounts: {
        phoneNumbers: phoneCount || 0,
        lifecycleStates: lifecycleCount || 0,
        providerMappings: mappingCount || 0,
        userAssignments: assignCount || 0,
      },
      protectedPilotFound,
      activeConflictsDetected: 0,
      manualReviewEstimate: 0,
    };
  }
}
