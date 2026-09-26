import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { getOrganizationEntitlements } from '@/lib/entitlements/server';
import { createTwilioServerClient } from '@/lib/twilio/client';
import { RetailPricingService, ServerRetailPriceResult } from './pricingService';
import { CommercialPricingService } from './commercialPricingService';
import { RegulatoryPreCheckService, RegulatoryPreCheckStatus, mapDomainToTwilioRegulationNumberType } from './regulatoryPreCheckService';
import { ComplianceProfileService } from '../compliance/complianceProfileService';
import { withTimeout } from './utils';

export type PurchaseReadinessState =
  | 'ready_for_next_step'
  | 'inventory_no_longer_available'
  | 'inventory_check_unavailable'
  | 'retail_price_unavailable'
  | 'commercial_safety_block'
  | 'number_limit_reached'
  | 'verification_required'
  | 'regulatory_check_unavailable'
  | 'unsupported_number_type'
  | 'error';

export type ReadinessNextAction = 'verification' | 'payment' | 'unavailable';

export interface PurchaseReadinessCandidate {
  phoneNumber: string;
  countryCode: string;
  numberType: 'local' | 'mobile' | 'toll_free';
  endUserType: 'business' | 'individual';
  cartSnapshotPriceFormatted?: string | null;
}

export interface PurchaseReadinessResult {
  readinessState: PurchaseReadinessState;
  nextAction: ReadinessNextAction;
  
  // Customer-Safe Metadata
  phoneNumber: string;
  countryCode: string;
  numberType: string;
  endUserType: 'business' | 'individual';
  currentRetailPrice: ServerRetailPriceResult;
  priceChanged: boolean;
  previousPriceFormatted: string | null;
  currentPriceFormatted: string | null;
  
  // Revalidated Operational Statuses
  exactInventoryAvailable: boolean;
  entitlementAllowed: boolean;
  verificationRequired: boolean;
  regulatoryStatus: RegulatoryPreCheckStatus;
  
  // Customer-Facing Messages
  customerMessage: string;
  warnings: string[];
}

/**
 * Server-Authoritative Purchase Readiness Service.
 * Revalidates exact inventory availability, retail pricing, commercial safety, entitlement limits, and regulatory requirements.
 * Never trusts browser parameters. Provider costs and margins remain strictly server-only.
 */
export class NumberPurchaseReadinessService {
  /**
   * Evaluates authoritative purchase readiness for a candidate marketplace number selection.
   */
  static async evaluateReadiness(
    organizationId: string,
    candidate: PurchaseReadinessCandidate
  ): Promise<PurchaseReadinessResult> {
    const warnings: string[] = [];
    const phoneNumber = (candidate.phoneNumber || '').trim();
    const countryCode = (candidate.countryCode || 'US').toUpperCase().trim();
    const numberType = candidate.numberType;
    const endUserType = candidate.endUserType || 'business';

    // 1. Validate number type fail-closed
    const mappedTwilioType = mapDomainToTwilioRegulationNumberType(numberType);
    if (!mappedTwilioType) {
      return {
        readinessState: 'unsupported_number_type',
        nextAction: 'unavailable',
        phoneNumber,
        countryCode,
        numberType,
        endUserType,
        currentRetailPrice: {
          hasConfiguredPrice: false,
          currency: 'USD',
          monthlyPriceMinor: null,
          monthlyPriceFormatted: null,
          priceModel: 'OPTION_A_CURRENT_PRICE_ONLY',
        },
        priceChanged: false,
        previousPriceFormatted: null,
        currentPriceFormatted: null,
        exactInventoryAvailable: false,
        entitlementAllowed: false,
        verificationRequired: false,
        regulatoryStatus: 'error',
        customerMessage: `Unsupported or invalid number category '${numberType}'.`,
        warnings: ['Unsupported number category.'],
      };
    }

    // 2. Execute independent readiness checks concurrently via Promise.all
    const startTime = Date.now();

    const exactInventoryPromise = (async (): Promise<boolean> => {
      try {
        const client = createTwilioServerClient();
        let twilioCategory: 'local' | 'mobile' | 'tollFree' = 'local';
        if (numberType === 'mobile') twilioCategory = 'mobile';
        if (numberType === 'toll_free') twilioCategory = 'tollFree';

        const subResource = (client.availablePhoneNumbers(countryCode) as any)[twilioCategory];
        if (subResource && typeof subResource.list === 'function') {
          const matches = await withTimeout<any[]>(
            subResource.list({ contains: phoneNumber, limit: 5 }),
            3000,
            []
          );
          return (matches || []).some(
            (m: any) => m.phoneNumber === phoneNumber || m.friendlyName === phoneNumber
          );
        }
      } catch (err: any) {
        console.warn(`[NumberPurchaseReadinessService] Exact inventory revalidation failed for ${phoneNumber}:`, err.message || err);
      }
      return false;
    })();

    const entitlementPromise = (async (): Promise<{ currentActiveCount: number; maxAllowedCount: number | null; entitlementAllowed: boolean }> => {
      let currentActiveCount = 0;
      let maxAllowedCount: number | null = null;
      let entitlementAllowed = true;
      try {
        const supabase = createAdminClient();
        const { count } = await (supabase as any)
          .from('phone_numbers')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', organizationId)
          .eq('active', true)
          .eq('status', 'active');

        if (count !== null) currentActiveCount = count;

        const { data: orgData } = await (supabase as any)
          .from('organizations')
          .select('max_phone_numbers')
          .eq('id', organizationId)
          .maybeSingle();

        maxAllowedCount = orgData?.max_phone_numbers ?? 50;
        if (maxAllowedCount !== null && currentActiveCount >= maxAllowedCount) {
          entitlementAllowed = false;
        }
      } catch (err: any) {
        console.warn('[NumberPurchaseReadinessService] Entitlement check exception:', err.message || err);
      }
      return { currentActiveCount, maxAllowedCount, entitlementAllowed };
    })();

    const [
      exactInventoryAvailable,
      currentRetailPrice,
      commercialMargin,
      commercialEnablement,
      entitlementRes,
      preCheck
    ] = await Promise.all([
      exactInventoryPromise,
      RetailPricingService.resolveRetailPrice(countryCode, numberType),
      CommercialPricingService.evaluateCommercialMargin(countryCode, numberType),
      CommercialPricingService.evaluateCommercialEnablement(countryCode, numberType),
      entitlementPromise,
      RegulatoryPreCheckService.evaluateRequirements(countryCode, numberType, endUserType),
    ]);

    const executionMs = Date.now() - startTime;
    console.log(`[NumberPurchaseReadinessService] Server readiness checks completed concurrently in ${executionMs}ms`);

    // 3. Process Inventory Availability Result
    if (!exactInventoryAvailable) {
      return {
        readinessState: 'inventory_no_longer_available',
        nextAction: 'unavailable',
        phoneNumber,
        countryCode,
        numberType,
        endUserType,
        currentRetailPrice,
        priceChanged: false,
        previousPriceFormatted: null,
        currentPriceFormatted: null,
        exactInventoryAvailable: false,
        entitlementAllowed: false,
        verificationRequired: false,
        regulatoryStatus: 'not_evaluated',
        customerMessage: 'This phone number is no longer available from the provider.',
        warnings: ['Selected E.164 number is no longer present in provider available inventory.'],
      };
    }

    // 4. Process Launch Enablement & Commercial Configuration Result
    if (!commercialEnablement.launchEnabled) {
      return {
        readinessState: 'commercial_safety_block',
        nextAction: 'unavailable',
        phoneNumber,
        countryCode,
        numberType,
        endUserType,
        currentRetailPrice,
        priceChanged: false,
        previousPriceFormatted: null,
        currentPriceFormatted: null,
        exactInventoryAvailable: true,
        entitlementAllowed: false,
        verificationRequired: false,
        regulatoryStatus: 'not_evaluated',
        customerMessage: 'Not currently available for purchase in this region.',
        warnings: ['Country/number type is not currently launch-enabled in server configuration.'],
      };
    }

    if (!currentRetailPrice.hasConfiguredPrice || currentRetailPrice.monthlyPriceFormatted === null) {
      return {
        readinessState: 'retail_price_unavailable',
        nextAction: 'unavailable',
        phoneNumber,
        countryCode,
        numberType,
        endUserType,
        currentRetailPrice,
        priceChanged: false,
        previousPriceFormatted: null,
        currentPriceFormatted: null,
        exactInventoryAvailable: true,
        entitlementAllowed: false,
        verificationRequired: false,
        regulatoryStatus: 'not_evaluated',
        customerMessage: 'Monthly pricing is currently unavailable for this line category.',
        warnings: ['No active retail price configured in public.phone_number_retail_prices.'],
      };
    }

    // Detect price change vs cart snapshot
    let priceChanged = false;
    let previousPriceFormatted: string | null = candidate.cartSnapshotPriceFormatted || null;
    let currentPriceFormatted: string | null = currentRetailPrice.monthlyPriceFormatted;

    if (
      previousPriceFormatted &&
      previousPriceFormatted.trim() !== '' &&
      previousPriceFormatted !== currentPriceFormatted
    ) {
      priceChanged = true;
      warnings.push(`Monthly retail price updated from ${previousPriceFormatted} to ${currentPriceFormatted}.`);
    }

    // 5. Process Commercial Safety Margin Result
    if (
      commercialMargin.commercialSafetyState === 'negative_margin' ||
      commercialMargin.commercialSafetyState === 'provider_cost_unavailable'
    ) {
      return {
        readinessState: 'commercial_safety_block',
        nextAction: 'unavailable',
        phoneNumber,
        countryCode,
        numberType,
        endUserType,
        currentRetailPrice,
        priceChanged,
        previousPriceFormatted,
        currentPriceFormatted,
        exactInventoryAvailable: true,
        entitlementAllowed: false,
        verificationRequired: false,
        regulatoryStatus: 'not_evaluated',
        customerMessage: 'This number is temporarily unavailable for purchase.',
        warnings: ['Commercial safety check failed (negative margin or unvalidated provider cost).'],
      };
    }

    // 6. Process Workspace Entitlement Capacity Result
    if (!entitlementRes.entitlementAllowed) {
      return {
        readinessState: 'number_limit_reached',
        nextAction: 'unavailable',
        phoneNumber,
        countryCode,
        numberType,
        endUserType,
        currentRetailPrice,
        priceChanged,
        previousPriceFormatted,
        currentPriceFormatted,
        exactInventoryAvailable: true,
        entitlementAllowed: false,
        verificationRequired: false,
        regulatoryStatus: 'not_evaluated',
        customerMessage: `Your workspace has reached its maximum phone number capacity (${entitlementRes.currentActiveCount}/${entitlementRes.maxAllowedCount}).`,
        warnings: ['Workspace number capacity limit reached.'],
      };
    }

    // 7. Process Regulatory Requirements Result
    if (preCheck.status === 'unavailable' || preCheck.status === 'error') {
      return {
        readinessState: 'regulatory_check_unavailable',
        nextAction: 'unavailable',
        phoneNumber,
        countryCode,
        numberType,
        endUserType,
        currentRetailPrice,
        priceChanged,
        previousPriceFormatted,
        currentPriceFormatted,
        exactInventoryAvailable: true,
        entitlementAllowed: true,
        verificationRequired: false,
        regulatoryStatus: preCheck.status,
        customerMessage: 'Regulatory requirement check is temporarily unavailable right now.',
        warnings: ['Provider regulatory regulations API returned error/unavailable.'],
      };
    }

    const verificationRequired = preCheck.bundleRequired || preCheck.status === 'requirements_found';

    if (verificationRequired) {
      // Evaluate Phase 11.3E 5-Tier Compliance Reuse
      let hasApprovedReuse = false;
      try {
        const reuseResult = await ComplianceProfileService.evaluateOrganizationReuseState(
          organizationId,
          countryCode,
          numberType,
          endUserType,
          preCheck,
          'admin'
        );
        hasApprovedReuse = reuseResult.hasApprovedReuse && reuseResult.tierE_approvalReusable;
      } catch (err: any) {
        console.warn('[NumberPurchaseReadinessService] Reuse evaluation exception:', err.message || err);
      }

      if (!hasApprovedReuse) {
        return {
          readinessState: 'verification_required',
          nextAction: 'verification',
          phoneNumber,
          countryCode,
          numberType,
          endUserType,
          currentRetailPrice,
          priceChanged,
          previousPriceFormatted,
          currentPriceFormatted,
          exactInventoryAvailable: true,
          entitlementAllowed: true,
          verificationRequired: true,
          regulatoryStatus: preCheck.status,
          customerMessage: 'Additional verification is required for this number.',
          warnings,
        };
      }
    }

    // Passed all readiness checks cleanly!
    return {
      readinessState: 'ready_for_next_step',
      nextAction: 'payment',
      phoneNumber,
      countryCode,
      numberType,
      endUserType,
      currentRetailPrice,
      priceChanged,
      previousPriceFormatted,
      currentPriceFormatted,
      exactInventoryAvailable: true,
      entitlementAllowed: true,
      verificationRequired: false,
      regulatoryStatus: preCheck.status,
      customerMessage: 'This number is ready for checkout.',
      warnings,
    };
  }
}

export const purchaseReadinessService = new NumberPurchaseReadinessService();

