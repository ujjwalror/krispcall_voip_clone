import 'server-only';
import { NextResponse } from 'next/server';
import { User, SupabaseClient } from '@supabase/supabase-js';
import { createServerSupabaseClient } from '@/lib/supabase/server';

export type FeatureValueType = 'boolean' | 'numeric' | 'text';

export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'expired'
  | 'suspended';

export interface ResolvedEntitlement {
  featureCode: string;
  valueType: FeatureValueType;
  enabled: boolean;
  numericValue: number | null;
  textValue: string | null;
  source: 'override' | 'plan' | 'default_deny';
  overrideReason?: string | null;
  overrideExpiresAt?: string | null;
}

export interface OrganizationEntitlementsResult {
  success: true;
  organizationId: string;
  subscriptionStatus: SubscriptionStatus;
  planCode: string;
  planName: string;
  isTrialValid: boolean;
  isSubscriptionActive: boolean;
  entitlements: Record<string, ResolvedEntitlement>;
}

export type EntitlementResolutionError =
  | 'unauthorized'
  | 'profile_not_found'
  | 'profile_inactive'
  | 'subscription_missing'
  | 'plan_missing'
  | 'database_error';

export type GetOrganizationEntitlementsReturn =
  | OrganizationEntitlementsResult
  | {
      success: false;
      error: EntitlementResolutionError;
      message: string;
    };

export type RequireEntitlementResult =
  | {
      success: true;
      organizationId: string;
      user: User;
      supabase: SupabaseClient;
      entitlement: ResolvedEntitlement;
    }
  | {
      success: false;
      errorResponse: NextResponse;
    };

/**
 * Safely parses and validates finite numeric values.
 * Returns null for null, undefined, NaN, Infinity, -Infinity, or non-finite numbers.
 */
function parseFiniteNumber(val: any): number | null {
  if (val === null || val === undefined || val === '') return null;
  const num = Number(val);
  return Number.isFinite(num) ? num : null;
}

/**
 * Server-only helper to resolve the effective entitlements for the currently authenticated user's organization.
 * Derives organization identity strictly from auth.uid() -> profiles.organization_id.
 */
export async function getOrganizationEntitlements(
  clientOverride?: SupabaseClient
): Promise<GetOrganizationEntitlementsReturn> {
  try {
    const supabase = clientOverride || (await createServerSupabaseClient());

    // 1. Authenticate user
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      return {
        success: false,
        error: 'unauthorized',
        message: 'Unauthorized. Authenticated user session required.',
      };
    }

    // 2. Fetch authenticated profile & organization_id
    const { data: profile, error: profileError } = await (supabase as any)
      .from('profiles')
      .select('organization_id, active')
      .eq('id', user.id)
      .maybeSingle();

    if (profileError || !profile || !profile.organization_id) {
      return {
        success: false,
        error: 'profile_not_found',
        message: 'User profile or organization assignment not found.',
      };
    }

    if (profile.active === false) {
      return {
        success: false,
        error: 'profile_inactive',
        message: 'User profile account is currently inactive.',
      };
    }

    return await resolveEntitlementsForOrgId(profile.organization_id, supabase);
  } catch (err: any) {
    console.error('[Entitlement Engine] Exception resolving organization entitlements:', err.message || err);
    return {
      success: false,
      error: 'database_error',
      message: 'Internal server error resolving entitlements.',
    };
  }
}

/**
 * Internal resolver implementation.
 */
async function resolveEntitlementsForOrgId(
  organizationId: string,
  supabase: SupabaseClient
): Promise<GetOrganizationEntitlementsReturn> {
  // 1. Fetch organization subscription
  const { data: subscription, error: subError } = await (supabase as any)
    .from('organization_subscriptions')
    .select('id, organization_id, plan_id, status, trial_ends_at, current_period_end')
    .eq('organization_id', organizationId)
    .maybeSingle();

  if (subError || !subscription) {
    return {
      success: false,
      error: 'subscription_missing',
      message: 'No subscription row found for this organization.',
    };
  }

  const status = subscription.status as SubscriptionStatus;
  const now = Date.now();

  // Evaluate trial validity
  let isTrialValid = true;
  if (status === 'trialing' && subscription.trial_ends_at) {
    if (new Date(subscription.trial_ends_at).getTime() <= now) {
      isTrialValid = false;
    }
  }

  // Evaluate canceled period validity
  let isCanceledPeriodValid = true;
  if (status === 'canceled' && subscription.current_period_end) {
    if (new Date(subscription.current_period_end).getTime() <= now) {
      isCanceledPeriodValid = false;
    }
  }

  // Active status determination
  const isSubscriptionActive =
    (status === 'active') ||
    (status === 'trialing' && isTrialValid) ||
    (status === 'canceled' && isCanceledPeriodValid) ||
    (status === 'past_due');

  // 2. Fetch assigned Plan metadata
  const { data: plan, error: planError } = await (supabase as any)
    .from('plans')
    .select('id, code, name, is_active')
    .eq('id', subscription.plan_id)
    .maybeSingle();

  if (planError || !plan || !plan.is_active) {
    return {
      success: false,
      error: 'plan_missing',
      message: 'Subscription refers to an inactive or missing plan.',
    };
  }

  // 3. Fetch Plan Entitlements
  const { data: planEntitlementsData } = await (supabase as any)
    .from('plan_entitlements')
    .select('feature_code, enabled, numeric_value, text_value, features(code, value_type)')
    .eq('plan_id', plan.id);

  // 4. Fetch Organization Overrides
  const { data: overridesData } = await (supabase as any)
    .from('organization_entitlement_overrides')
    .select('feature_code, enabled, numeric_value, text_value, expires_at, reason, features(code, value_type)')
    .eq('organization_id', organizationId);

  // Map features and build entitlement dictionary
  const rawPlanEnts = (planEntitlementsData || []) as any[];
  const rawOverrides = (overridesData || []) as any[];

  const entitlementsMap: Record<string, ResolvedEntitlement> = {};

  // Process Plan Entitlements first
  for (const item of rawPlanEnts) {
    const code = item.feature_code;
    const valueType: FeatureValueType = item.features?.value_type || 'boolean';
    const parsedNum = isSubscriptionActive && item.numeric_value !== null ? parseFiniteNumber(item.numeric_value) : null;

    const isEnabled = isSubscriptionActive
      ? Boolean(item.enabled) && (valueType !== 'numeric' || parsedNum !== null)
      : false;

    entitlementsMap[code] = {
      featureCode: code,
      valueType,
      enabled: isEnabled,
      numericValue: parsedNum,
      textValue: isSubscriptionActive ? item.text_value || null : null,
      source: 'plan',
    };
  }

  // Apply active, non-expired Overrides (higher precedence)
  for (const item of rawOverrides) {
    const code = item.feature_code;
    const valueType: FeatureValueType = item.features?.value_type || 'boolean';

    // Check expiry
    let isExpiredOverride = false;
    if (item.expires_at) {
      if (new Date(item.expires_at).getTime() <= now) {
        isExpiredOverride = true;
      }
    }

    if (!isExpiredOverride) {
      const parsedNum = isSubscriptionActive && item.numeric_value !== null ? parseFiniteNumber(item.numeric_value) : null;

      const isEnabled = isSubscriptionActive
        ? Boolean(item.enabled) && (valueType !== 'numeric' || parsedNum !== null)
        : false;

      entitlementsMap[code] = {
        featureCode: code,
        valueType,
        enabled: isEnabled,
        numericValue: parsedNum,
        textValue: isSubscriptionActive ? item.text_value || null : null,
        source: 'override',
        overrideReason: item.reason || null,
        overrideExpiresAt: item.expires_at || null,
      };
    }
  }

  return {
    success: true,
    organizationId,
    subscriptionStatus: status,
    planCode: plan.code,
    planName: plan.name,
    isTrialValid,
    isSubscriptionActive,
    entitlements: entitlementsMap,
  };
}

/**
 * Server-only helper to check if a boolean feature entitlement is enabled for the authenticated organization.
 */
export async function hasEntitlement(
  featureCode: string,
  clientOverride?: SupabaseClient
): Promise<boolean> {
  const result = await getOrganizationEntitlements(clientOverride);
  if (!result.success || !result.isSubscriptionActive) return false;

  const entitlement = result.entitlements[featureCode];
  if (!entitlement) return false;

  return entitlement.enabled === true;
}

/**
 * Server-only helper to obtain the numeric entitlement limit for a feature.
 * Returns null if missing, disabled, or if subscription is inactive.
 */
export async function getEntitlementLimit(
  featureCode: string,
  clientOverride?: SupabaseClient
): Promise<number | null> {
  const result = await getOrganizationEntitlements(clientOverride);
  if (!result.success || !result.isSubscriptionActive) return null;

  const entitlement = result.entitlements[featureCode];
  if (!entitlement || !entitlement.enabled) return null;

  if (entitlement.numericValue === null || !Number.isFinite(entitlement.numericValue)) {
    return null;
  }

  return entitlement.numericValue;
}

/**
 * Server-only helper to obtain the text value of a feature entitlement.
 * Returns null if missing or disabled.
 */
export async function getEntitlementText(
  featureCode: string,
  clientOverride?: SupabaseClient
): Promise<string | null> {
  const result = await getOrganizationEntitlements(clientOverride);
  if (!result.success || !result.isSubscriptionActive) return null;

  const entitlement = result.entitlements[featureCode];
  if (!entitlement || !entitlement.enabled) return null;

  return entitlement.textValue;
}

/**
 * Authoritative Next.js API route guard helper for enforcing feature entitlements.
 * Fails closed with appropriate 401/403 HTTP JSON responses.
 */
export async function requireEntitlement(
  featureCode: string,
  customHeaders?: Record<string, string>
): Promise<RequireEntitlementResult> {
  const supabase = await createServerSupabaseClient();

  // 1. Authenticate user session
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return {
      success: false,
      errorResponse: NextResponse.json(
        { error: 'Unauthorized. Authenticated user session required.', code: 'unauthorized' },
        { status: 401, headers: customHeaders }
      ),
    };
  }

  // 2. Resolve organization entitlements
  const result = await getOrganizationEntitlements(supabase);

  if (!result.success) {
    let statusCode = 403;
    let errCode = 'subscription_missing';

    if (result.error === 'unauthorized') {
      statusCode = 401;
      errCode = 'unauthorized';
    } else if (result.error === 'subscription_missing') {
      statusCode = 403;
      errCode = 'subscription_missing';
    } else if (result.error === 'plan_missing') {
      statusCode = 403;
      errCode = 'plan_missing';
    }

    return {
      success: false,
      errorResponse: NextResponse.json(
        { error: result.message, code: errCode },
        { status: statusCode, headers: customHeaders }
      ),
    };
  }

  // 3. Check subscription active state
  if (!result.isSubscriptionActive) {
    return {
      success: false,
      errorResponse: NextResponse.json(
        {
          error: `Subscription is ${result.subscriptionStatus}. Feature access is currently restricted.`,
          code: 'subscription_inactive',
        },
        { status: 403, headers: customHeaders }
      ),
    };
  }

  // 4. Check feature entitlement
  const entitlement = result.entitlements[featureCode];

  if (!entitlement || !entitlement.enabled) {
    return {
      success: false,
      errorResponse: NextResponse.json(
        {
          error: `Feature "${featureCode}" is not included in your current subscription plan.`,
          code: 'entitlement_required',
        },
        { status: 403, headers: customHeaders }
      ),
    };
  }

  return {
    success: true,
    organizationId: result.organizationId,
    user,
    supabase,
    entitlement,
  };
}
