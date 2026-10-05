import { NextResponse } from 'next/server';
import { requireActiveSession } from '@/lib/auth/requireActiveSession';
import { getOrganizationEntitlements } from '@/lib/entitlements/server';
import { TwilioInventoryProvider, NumberCategory } from '@/lib/telephony/marketplace/inventoryProvider';
import { createAdminClient } from '@/lib/supabase/admin';
import { MarketplaceSuppressionService } from '@/lib/telephony/marketplace/marketplaceSuppressionService';

/**
 * GET /api/number-marketplace/search
 * Live inventory discovery and filter capability API for Number Marketplace.
 * Tenant-authenticated, entitlement-aware, server-only provider calls.
 */
export async function GET(request: Request) {
  try {
    const sessionResult = await requireActiveSession();
    if (!sessionResult.success) {
      return sessionResult.errorResponse;
    }

    const { user, supabase } = sessionResult;

    const { data: profile } = await supabase
      .from('profiles')
      .select('organization_id, role, active')
      .eq('id', user.id)
      .maybeSingle();

    if (!profile || !profile.organization_id || profile.active === false) {
      return NextResponse.json(
        { error: 'Forbidden. Active organization profile required.' },
        { status: 403 }
      );
    }

    // Parse & validate URL search params
    const { searchParams } = new URL(request.url);
    const countryCode = (searchParams.get('country') || 'US').toUpperCase().trim();
    const rawType = (searchParams.get('type') || 'local').toLowerCase().trim();
    const numberType: NumberCategory = ['local', 'mobile', 'toll_free'].includes(rawType)
      ? (rawType as NumberCategory)
      : 'local';

    const contains = searchParams.get('contains') || undefined;
    const areaCode = searchParams.get('areaCode') || undefined;
    const locality = searchParams.get('locality') || undefined;
    const region = searchParams.get('region') || undefined;
    const postalCode = searchParams.get('postalCode') || undefined;

    const voiceParam = searchParams.get('voice');
    const smsParam = searchParams.get('sms');
    const mmsParam = searchParams.get('mms');

    const voiceEnabled = voiceParam === 'true' ? true : voiceParam === 'false' ? false : undefined;
    const smsEnabled = smsParam === 'true' ? true : smsParam === 'false' ? false : undefined;
    const mmsEnabled = mmsParam === 'true' ? true : mmsParam === 'false' ? false : undefined;

    const limitParam = parseInt(searchParams.get('limit') || '50', 10);
    const limit = Math.min(Math.max(isNaN(limitParam) ? 50 : limitParam, 1), 100);

    const provider = new TwilioInventoryProvider();

    // Evaluate dynamic filter capabilities for selected country + numberType
    const filterCapabilities = provider.getFilterCapabilities(countryCode, numberType);

    // Execute live provider inventory search using applicable search parameters
    const rawNumbers = await provider.searchAvailableNumbers({
      countryCode,
      numberType,
      contains,
      areaCode,
      locality,
      region,
      postalCode,
      voiceEnabled,
      smsEnabled,
      mmsEnabled,
      limit,
    });

    // PLATFORM-GLOBAL MARKETPLACE SUPPRESSION
    // Extract returned candidate E.164 strings for suppression evaluation
    const candidateE164s = rawNumbers.map((item) => item.phoneNumber).filter(Boolean);

    const suppressionRes = await MarketplaceSuppressionService.getSuppressedPhoneNumbers(
      candidateE164s.length > 0 ? candidateE164s : undefined
    );

    // CRITICAL FAIL-CLOSED SAFETY:
    // If suppression query fails, DO NOT return unsuppressed provider inventory.
    if (!suppressionRes.success) {
      console.error('[GET /api/number-marketplace/search] Suppression query failed:', suppressionRes.error);
      return NextResponse.json(
        { error: 'Inventory search is temporarily unavailable. Unable to verify number availability.' },
        { status: 503 }
      );
    }

    // Filter out platform-global active owned numbers, active purchase operation locks,
    // and apply defensive server-side fail-closed capability verification
    const suppressedSet = suppressionRes.suppressedSet;
    const cleanNumbers = rawNumbers.filter((item) => {
      if (suppressedSet.has(item.phoneNumber)) return false;
      if (voiceEnabled === true && !item.capabilities.voice) return false;
      if (smsEnabled === true && !item.capabilities.sms) return false;
      if (mmsEnabled === true && !item.capabilities.mms) return false;
      return true;
    });

    // Entitlement resolution for UI awareness
    const adminSupabase = createAdminClient();
    const { count: currentActiveNumbers } = await (adminSupabase as any)
      .from('phone_numbers')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', profile.organization_id)
      .eq('active', true);

    const entitlementsRes = await getOrganizationEntitlements(supabase);
    let maxActiveNumbers: number | null = null;

    if (entitlementsRes.success && entitlementsRes.entitlements['number.max_active']) {
      maxActiveNumbers = entitlementsRes.entitlements['number.max_active'].numericValue;
    }

    // Optional provider pricing audit info (read-only for Phase 8.1 report)
    const pricingAudit = await provider.auditProviderPricing(countryCode);

    return NextResponse.json({
      success: true,
      query: {
        countryCode,
        numberType,
        limit,
      },
      filterCapabilities,
      numbers: cleanNumbers,
      count: cleanNumbers.length,
      entitlements: {
        currentActive: currentActiveNumbers || 0,
        maxActive: maxActiveNumbers,
        canPurchaseMore: maxActiveNumbers === null || (currentActiveNumbers || 0) < maxActiveNumbers,
      },
      pricingAudit: {
        currency: pricingAudit.currency,
        phoneNumberPrices: pricingAudit.phoneNumberPrices,
        note: pricingAudit.note,
      },
    });
  } catch (error: any) {
    console.error('[GET /api/number-marketplace/search] Exception:', error.message || error);
    return NextResponse.json(
      { error: 'Internal server error searching number marketplace.' },
      { status: 500 }
    );
  }
}
