import { NextResponse } from 'next/server';
import { requireActiveSession } from '@/lib/auth/requireActiveSession';
import { getOrganizationEntitlements } from '@/lib/entitlements/server';
import { TwilioInventoryProvider, NumberCategory, InvalidContinuationTokenError } from '@/lib/telephony/marketplace/inventoryProvider';
import { createAdminClient } from '@/lib/supabase/admin';
import { MarketplaceSuppressionService } from '@/lib/telephony/marketplace/marketplaceSuppressionService';
import { MarketplaceSearchDefenseService } from '@/lib/telephony/marketplace/marketplaceSearchDefenseService';

/**
 * GET /api/number-marketplace/search
 * Live inventory discovery and filter capability API for Number Marketplace.
 * Tenant-authenticated, entitlement-aware, server-only provider calls.
 * Protected by distributed rate limiting (SEC7B-01) and safe identical-query cache.
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
    const pageToken = searchParams.get('pageToken') || undefined;

    // SEC7B-01 DEFENSE: DISTRIBUTED RATE LIMITER
    // Check authoritative PostgreSQL rate limiter for (user, organization) sliding window.
    // 15 req/60s per user, 60 req/60s per organization ceiling. Fails closed.
    const rateLimitRes = await MarketplaceSearchDefenseService.checkAndConsumeRateLimit({
      organizationId: profile.organization_id,
      userId: user.id,
    });

    if (!rateLimitRes.allowed) {
      return NextResponse.json(
        {
          error: 'Too Many Requests',
          message: rateLimitRes.reason || 'Marketplace search rate limit exceeded. Please wait before retrying.',
          retryAfter: rateLimitRes.retryAfterSeconds,
        },
        {
          status: 429,
          headers: {
            'Retry-After': String(rateLimitRes.retryAfterSeconds),
          },
        }
      );
    }

    const provider = new TwilioInventoryProvider();

    // Evaluate dynamic filter capabilities for selected country + numberType
    const filterCapabilities = provider.getFilterCapabilities(countryCode, numberType);

    // SEC7B-01 DEFENSE: SAFE CACHED INVENTORY SEARCH WITH SINGLE-FLIGHT STAMPEDE PROTECTION
    // Looks up L1 memory cache -> L2 distributed PostgreSQL cache -> upstream Twilio call.
    const searchData = await MarketplaceSearchDefenseService.executeSearchWithCache({
      query: {
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
        pageToken,
      },
      provider,
    });

    const rawNumbers = searchData.numbers || [];

    // PLATFORM-GLOBAL MARKETPLACE SUPPRESSION (ALWAYS EVALUATED REAL-TIME PER REQUEST)
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

    // Entitlement resolution for UI awareness (ALWAYS EVALUATED REAL-TIME PER ORGANIZATION)
    const adminSupabase = createAdminClient();
    const { count: currentActiveNumbers } = await (adminSupabase as any)
      .from('phone_numbers')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', profile.organization_id)
      .eq('active', true);

    // PHASE 23E.1: SaaS plans do NOT limit number quantity.
    // maxActive is unconstrained (null), canPurchaseMore is always true unless under explicit administrative/risk ceiling.
    const entitlementsRes = await getOrganizationEntitlements(supabase);
    let maxActiveNumbers: number | null = null;

    if (entitlementsRes.success && entitlementsRes.entitlements['number.risk_limit']?.numericValue) {
      maxActiveNumbers = entitlementsRes.entitlements['number.risk_limit'].numericValue;
    }

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
      hasMore: searchData.hasMore,
      continuationToken: searchData.continuationToken,
      entitlements: {
        currentActive: currentActiveNumbers || 0,
        maxActive: maxActiveNumbers,
        canPurchaseMore: maxActiveNumbers === null || (currentActiveNumbers || 0) < maxActiveNumbers,
      },
      pricingAudit: {
        currency: searchData.pricingAudit.currency,
        phoneNumberPrices: searchData.pricingAudit.phoneNumberPrices,
        note: searchData.pricingAudit.note,
      },
    });
  } catch (error: any) {
    if (error instanceof InvalidContinuationTokenError || error.name === 'InvalidContinuationTokenError') {
      console.warn('[GET /api/number-marketplace/search] Invalid continuation token:', error.code, error.message);
      return NextResponse.json(
        { error: 'Invalid or expired continuation token. Please refresh your search.' },
        { status: 400 }
      );
    }

    console.error('[GET /api/number-marketplace/search] Exception:', error.message || error);
    return NextResponse.json(
      { error: 'Internal server error searching number marketplace.' },
      { status: 500 }
    );
  }
}
