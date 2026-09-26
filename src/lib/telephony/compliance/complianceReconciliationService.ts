import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { ProviderOperationService } from './providerOperationService';
import { ProviderComplianceAdapter } from './providerComplianceAdapter';
import { ProviderComplianceOperation } from './types';

export class ComplianceReconciliationService {
  /**
   * Evaluates and reconciles all 'reconciliation_required' operations for an organization.
   */
  static async reconcileOrganizationOperations(
    organizationId: string,
    adapter: ProviderComplianceAdapter
  ): Promise<{ reconciled: number; resolvedSucceeded: number; resolvedFailed: number; unresolved: number }> {
    const supabase = createAdminClient() as any;

    const { data: opRows, error } = await supabase
      .from('provider_compliance_operations')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('status', 'reconciliation_required');

    if (error) {
      throw new Error(`Failed to load operations requiring reconciliation: ${error.message}`);
    }

    let resolvedSucceeded = 0;
    let resolvedFailed = 0;
    let unresolved = 0;

    for (const row of opRows || []) {
      const result = await this.reconcileSingleOperation(organizationId, row.id, adapter);
      if (result === 'succeeded') resolvedSucceeded++;
      else if (result === 'failed') resolvedFailed++;
      else unresolved++;
    }

    return {
      reconciled: (opRows || []).length,
      resolvedSucceeded,
      resolvedFailed,
      unresolved,
    };
  }

  /**
   * Reconciles a single operation by querying external provider status.
   */
  static async reconcileSingleOperation(
    organizationId: string,
    operationId: string,
    adapter: ProviderComplianceAdapter,
    clientOverride?: any
  ): Promise<'succeeded' | 'failed' | 'reconciliation_required'> {
    const supabase = clientOverride || (createAdminClient() as any);

    const { data: op } = await supabase
      .from('provider_compliance_operations')
      .select('*')
      .eq('id', operationId)
      .eq('organization_id', organizationId)
      .single();

    if (!op) {
      throw new Error(`Operation '${operationId}' not found.`);
    }

    if (op.status !== 'reconciliation_required') {
      return op.status as any;
    }

    const nowIso = new Date().toISOString();

    // Check provider resource lookup if resource ID is available
    if (op.provider_resource_id && op.provider_resource_type) {
      try {
        const providerRes = await adapter.getResourceStatus(op.provider_resource_type, op.provider_resource_id);
        if (['active', 'approved', 'passed', 'pending-review', 'succeeded', 'in-review'].includes(providerRes.status.toLowerCase())) {
          await supabase
            .from('provider_compliance_operations')
            .update({
              status: 'succeeded',
              completed_at: nowIso,
              last_reconciled_at: nowIso,
            })
            .eq('id', operationId)
            .eq('organization_id', organizationId);
          return 'succeeded';
        } else if (['rejected', 'failed', 'deleted'].includes(providerRes.status.toLowerCase())) {
          await supabase
            .from('provider_compliance_operations')
            .update({
              status: 'failed',
              last_reconciled_at: nowIso,
            })
            .eq('id', operationId)
            .eq('organization_id', organizationId);
          return 'failed';
        }
      } catch (err: any) {
        // Status check failed or resource unknown
      }
    }

    // Default: update last_reconciled_at and remain in reconciliation_required
    await supabase
      .from('provider_compliance_operations')
      .update({
        last_reconciled_at: nowIso,
      })
      .eq('id', operationId)
      .eq('organization_id', organizationId);

    return 'reconciliation_required';
  }
}
