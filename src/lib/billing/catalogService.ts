import 'server-only';
import { SupabaseClient } from '@supabase/supabase-js';
import { createServerSupabaseClient } from '@/lib/supabase/server';

export interface PublishedPlanEntitlement {
  featureCode: string;
  enabled: boolean;
  numericValue: number | null;
  textValue: string | null;
  valueType: string;
}

export interface PublishedPlanCatalogItem {
  planId: string;
  planVersionId: string;
  stableKey: string;
  code: string;
  name: string;
  description: string | null;
  version: number;
  billingInterval: string;
  currency: string;
  basePriceMinor: number | null;
  seatPriceMinor: number | null;
  entitlements: PublishedPlanEntitlement[];
}

export const EXCLUDED_PLAN_CODES = ['dev_unlimited'];
export const EXCLUDED_TEST_FIXTURE_ORGS = [
  '00000000-0000-1703-0000-000041492740',
  '00000000-0000-170d-0000-000042377193',
];

export class CatalogService {
  /**
   * Fetches published commercial plan versions for customer selection.
   * Strictly filters out dev_unlimited and unpublished/draft/retired versions.
   */
  static async getPublishedPlans(
    clientOverride?: SupabaseClient
  ): Promise<PublishedPlanCatalogItem[]> {
    const supabase = clientOverride || (await createServerSupabaseClient());

    // 1. Fetch public active plans with published versions
    const { data: versions, error } = await (supabase as any)
      .from('plan_versions')
      .select(`
        id,
        plan_id,
        version,
        status,
        billing_interval,
        currency,
        base_price_minor,
        seat_price_minor,
        stripe_product_id,
        stripe_base_price_id,
        stripe_seat_price_id,
        plans!inner (
          id,
          code,
          stable_key,
          name,
          description,
          is_active,
          is_public
        )
      `)
      .eq('status', 'published')
      .eq('plans.is_active', true)
      .eq('plans.is_public', true);

    if (error || !versions || versions.length === 0) {
      return [];
    }

    // Filter out dev_unlimited
    const filteredVersions = versions.filter((v: any) => {
      const code = v.plans?.code || v.plans?.stable_key;
      return code && !EXCLUDED_PLAN_CODES.includes(code.toLowerCase());
    });

    if (filteredVersions.length === 0) {
      return [];
    }

    const versionIds = filteredVersions.map((v: any) => v.id);

    // Fetch entitlements for these versions
    const { data: entitlementsData } = await (supabase as any)
      .from('plan_version_entitlements')
      .select(`
        plan_version_id,
        feature_code,
        enabled,
        numeric_value,
        text_value,
        features (
          code,
          value_type
        )
      `)
      .in('plan_version_id', versionIds);

    const entitlementsByVersion: Record<string, PublishedPlanEntitlement[]> = {};
    if (entitlementsData) {
      for (const item of entitlementsData as any[]) {
        const vId = item.plan_version_id;
        if (!entitlementsByVersion[vId]) {
          entitlementsByVersion[vId] = [];
        }
        entitlementsByVersion[vId].push({
          featureCode: item.feature_code,
          enabled: Boolean(item.enabled),
          numericValue: item.numeric_value !== null ? Number(item.numeric_value) : null,
          textValue: item.text_value || null,
          valueType: item.features?.value_type || 'boolean',
        });
      }
    }

    return filteredVersions.map((v: any) => ({
      planId: v.plans.id,
      planVersionId: v.id,
      stableKey: v.plans.stable_key || v.plans.code,
      code: v.plans.code,
      name: v.plans.name,
      description: v.plans.description || null,
      version: v.version,
      billingInterval: v.billing_interval || 'month',
      currency: v.currency || 'usd',
      basePriceMinor: v.base_price_minor !== null ? Number(v.base_price_minor) : null,
      seatPriceMinor: v.seat_price_minor !== null ? Number(v.seat_price_minor) : null,
      entitlements: entitlementsByVersion[v.id] || [],
    }));
  }
}
