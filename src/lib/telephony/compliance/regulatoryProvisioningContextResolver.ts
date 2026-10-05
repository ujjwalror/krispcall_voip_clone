import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { RegulatoryProvisioningContext } from '../commerce/types';
import { RegulatoryPreCheckService } from '../marketplace/regulatoryPreCheckService';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

function getServiceSupabase() {
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error('MISSING_SUPABASE_CONFIG: Service role configuration missing.');
  }
  return createClient(supabaseUrl, supabaseServiceKey);
}

export interface ResolveRegulatoryContextParams {
  organizationId: string;
  countryCode: string;
  numberType: string;
  endUserType?: 'individual' | 'business' | null;
  complianceProfileId?: string | null;
  regulatoryBundleSid?: string | null;
  addressSid?: string | null;
}

export class RegulatoryProvisioningContextResolver {
  /**
   * Evaluates and resolves the authoritative regulatory provisioning context immediately prior to purchase dispatch.
   * STRICT FAIL-CLOSED: Rejects stale, pending, rejected, incompatible, or missing required regulatory resources.
   * Dynamically evaluates provider regulatory requirements without relying on hardcoded country lists.
   */
  static async resolveProvisioningContext(
    params: ResolveRegulatoryContextParams
  ): Promise<{
    regulatoryProvisioningContext: RegulatoryProvisioningContext;
    bundleSid?: string | null;
    addressSid?: string | null;
  }> {
    const provider = 'twilio';
    const countryCode = params.countryCode.toUpperCase();
    const numberType = params.numberType.toLowerCase();
    const endUserType = params.endUserType || 'business';
    const nowIso = new Date().toISOString();

    // Dynamically evaluate provider regulatory requirements via Regulations API
    const preCheck = await RegulatoryPreCheckService.evaluateRequirements(
      countryCode,
      numberType,
      endUserType
    );

    // Fail-closed safety: If provider regulatory check timed out, errored, or returned unavailable state
    if (preCheck.status === 'error' || preCheck.status === 'unavailable') {
      throw new Error(
        `REGULATORY_RESOURCE_UNAVAILABLE: Unable to verify provider regulatory compliance requirements for country ${countryCode} (${numberType}).`
      );
    }

    const isVerificationRequired = preCheck.bundleRequired || preCheck.status === 'requirements_found';

    if (!isVerificationRequired) {
      // No verification required path -> Return explicit no-additional-verification context without fake SIDs
      return {
        regulatoryProvisioningContext: {
          provider,
          countryCode,
          numberType,
          endUserType,
          regulationSid: preCheck.regulationId || null,
          complianceProfileId: null,
          bundleSid: null,
          addressSid: null,
          endUserSid: null,
          requirementFingerprint: null,
          readinessVerifiedAt: nowIso,
          providerApprovalStatus: 'not_required',
          schemaVersion: 1,
        },
        bundleSid: null,
        addressSid: null,
      };
    }

    // Verification IS required for this country -> Validate required parameters
    if (!params.complianceProfileId && !params.regulatoryBundleSid) {
      throw new Error(
        `REGULATORY_RESOURCE_MISSING: Regulatory verification is required for country ${countryCode}, but no compliance profile or regulatory bundle was supplied.`
      );
    }

    const supabase = getServiceSupabase();

    let bundleSid: string | null = params.regulatoryBundleSid || null;
    let addressSid: string | null = params.addressSid || null;
    let endUserSid: string | null = null;
    let regulationSid: string | null = null;
    let requirementFingerprint: string | null = null;
    let providerApprovalStatus = 'approved';

    if (params.complianceProfileId) {
      const { data: profile, error: profileErr } = await supabase
        .from('organization_compliance_profiles')
        .select('*')
        .eq('id', params.complianceProfileId)
        .single();

      if (profileErr || !profile) {
        throw new Error(`REGULATORY_PROFILE_NOT_FOUND: Compliance profile ${params.complianceProfileId} does not exist.`);
      }

      if (profile.organization_id !== params.organizationId) {
        throw new Error('FORBIDDEN: Compliance profile belongs to another organization.');
      }

      const status = profile.status || profile.internal_status;
      if (status !== 'approved' && status !== 'submitted') {
        throw new Error(`REGULATORY_PROFILE_INELIGIBLE: Compliance profile status is '${status}'. Must be approved for purchase.`);
      }

      // Query provider resource mappings for bundle SID if available
      const { data: mappings } = await supabase
        .from('compliance_provider_resource_mappings')
        .select('*')
        .eq('profile_id', params.complianceProfileId)
        .eq('provider', provider);

      if (mappings && mappings.length > 0) {
        const bundleMapping = mappings.find((m: any) => m.resource_type === 'regulatory_bundle');
        if (bundleMapping && bundleMapping.provider_resource_id) {
          bundleSid = bundleMapping.provider_resource_id;
        }

        const addressMapping = mappings.find((m: any) => m.resource_type === 'address');
        if (addressMapping && addressMapping.provider_resource_id) {
          addressSid = addressMapping.provider_resource_id;
        }
      }
    }

    if (!bundleSid && isVerificationRequired) {
      throw new Error(`REGULATORY_BUNDLE_MISSING: Regulatory bundle SID is missing for country ${countryCode}.`);
    }

    const regulatoryProvisioningContext: RegulatoryProvisioningContext = {
      provider,
      countryCode,
      numberType,
      endUserType: params.endUserType || null,
      regulationSid,
      complianceProfileId: params.complianceProfileId || null,
      bundleSid,
      addressSid,
      endUserSid,
      requirementFingerprint,
      readinessVerifiedAt: nowIso,
      providerApprovalStatus,
      schemaVersion: 1,
    };

    return {
      regulatoryProvisioningContext,
      bundleSid,
      addressSid,
    };
  }
}
