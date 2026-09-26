import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { ComplianceResourceType, ProviderResourceMapping } from './types';

export interface ResourceCompatibilityContext {
  countryCode: string;
  numberType: 'local' | 'mobile' | 'toll_free';
  endUserType: 'business' | 'individual';
  providerRegulationId?: string | null;
}

export class ProviderResourceMappingService {
  /**
   * Saves or updates a tenant-scoped provider resource SID mapping in database.
   * Fails closed if database table or connection is unavailable.
   */
  static async recordMapping(
    organizationId: string,
    complianceProfileId: string,
    resourceType: ComplianceResourceType,
    providerResourceId: string,
    context: ResourceCompatibilityContext,
    sourceEntityId: string = 'primary',
    providerStatus: string = 'draft',
    metadata: Record<string, any> = {},
    clientOverride?: any
  ): Promise<ProviderResourceMapping> {
    const supabase = clientOverride || (createAdminClient() as any);

    const rowPayload = {
      organization_id: organizationId,
      compliance_profile_id: complianceProfileId,
      provider: 'twilio',
      resource_type: resourceType,
      provider_resource_id: providerResourceId,
      source_entity_id: sourceEntityId,
      country_code: context.countryCode.toUpperCase(),
      number_type: context.numberType,
      end_user_type: context.endUserType,
      provider_regulation_id: context.providerRegulationId || null,
      provider_status: providerStatus,
      metadata,
    };

    const { data, error } = await supabase
      .from('provider_resource_mappings')
      .upsert(rowPayload, {
        onConflict: 'organization_id,provider,resource_type,provider_resource_id',
      })
      .select()
      .single();

    if (error || !data) {
      throw new Error(`DB_FAIL_CLOSED: Failed to record provider resource mapping: ${error?.message}`);
    }

    return this.mapRow(data);
  }

  /**
   * Retrieves provider resource mappings for an organization and compliance profile.
   */
  static async getMappingsForProfile(
    organizationId: string,
    complianceProfileId: string,
    clientOverride?: any
  ): Promise<ProviderResourceMapping[]> {
    const supabase = clientOverride || (createAdminClient() as any);

    const { data, error } = await supabase
      .from('provider_resource_mappings')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('compliance_profile_id', complianceProfileId);

    if (error) {
      throw new Error(`DB_FAIL_CLOSED: Failed to retrieve provider resource mappings: ${error.message}`);
    }

    return (data || []).map((row: any) => this.mapRow(row));
  }

  /**
   * Checks if an existing provider resource mapping is compatible with a target regulatory context.
   * Universal approval reuse across different regulatory contexts (e.g. AU Local vs AU Mobile) is strictly FORBIDDEN.
   */
  static isResourceCompatible(
    mapping: ProviderResourceMapping,
    targetContext: ResourceCompatibilityContext
  ): boolean {
    if (mapping.countryCode.toUpperCase() !== targetContext.countryCode.toUpperCase()) {
      return false;
    }
    if (mapping.numberType !== targetContext.numberType) {
      return false;
    }
    if (mapping.endUserType !== targetContext.endUserType) {
      return false;
    }
    if (
      targetContext.providerRegulationId &&
      mapping.providerRegulationId &&
      mapping.providerRegulationId !== targetContext.providerRegulationId
    ) {
      return false;
    }
    return true;
  }

  private static mapRow(row: any): ProviderResourceMapping {
    return {
      id: row.id,
      organizationId: row.organization_id,
      complianceProfileId: row.compliance_profile_id,
      provider: row.provider,
      resourceType: row.resource_type,
      providerResourceId: row.provider_resource_id,
      sourceEntityId: row.source_entity_id || 'primary',
      countryCode: row.country_code,
      numberType: row.number_type,
      endUserType: row.end_user_type,
      providerRegulationId: row.provider_regulation_id,
      providerStatus: row.provider_status,
      metadata: row.metadata || {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
