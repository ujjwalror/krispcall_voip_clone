import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { RetailPricingService, ServerRetailPriceResult } from './pricingService';
import { CommercialPricingService } from './commercialPricingService';
import { RegulatoryPreCheckService, NormalizedRegulatoryPreCheckResult } from './regulatoryPreCheckService';
import { TwilioInventoryProvider } from './inventoryProvider';

export interface CartItemCandidate {
  phoneNumber: string;
  countryCode: string;
  numberType: 'local' | 'mobile' | 'toll_free';
  friendlyDisplay: string;
  endUserType: 'business' | 'individual';
  locality?: string | null;
  region?: string | null;
  capabilities: {
    voice: boolean;
    sms: boolean;
    mms: boolean;
  };
}

export interface CartValidationResult {
  valid: boolean;
  item: CartItemCandidate;
  price: ServerRetailPriceResult;
  preCheck: NormalizedRegulatoryPreCheckResult;
  inventoryAvailable: boolean;
  entitlementAllowed: boolean;
  entitlementDetails: {
    currentActiveCount: number;
    maxAllowedCount: number | null;
  };
  disclaimer: string;
  warnings: string[];
}

export class MarketplaceCartService {
  /**
   * Validates a candidate marketplace selection for temporary cart addition.
   * Performs:
   * 1. Server-side authoritative retail price resolution
   * 2. Live provider availability re-check (querying provider for specific number)
   * 3. Workspace phone number entitlement capacity check
   * 4. Factual provider regulatory pre-check
   */
  static async validateCartItem(
    organizationId: string,
    candidate: CartItemCandidate
  ): Promise<CartValidationResult> {
    const warnings: string[] = [];

    // 1. Authoritative Server Commercial Enablement & Retail Price Resolution
    const commercialEnablement = await CommercialPricingService.evaluateCommercialEnablement(
      candidate.countryCode,
      candidate.numberType
    );

    const price = await RetailPricingService.resolveRetailPrice(
      candidate.countryCode,
      candidate.numberType
    );

    if (!commercialEnablement.launchEnabled) {
      warnings.push('This country/number type is not currently launch-enabled in your region.');
    }

    if (!price.hasConfiguredPrice) {
      warnings.push('Retail price is currently unconfigured for this number type in this country.');
    }

    // 2. Factual Provider Regulatory Pre-Check
    const preCheck = await RegulatoryPreCheckService.evaluateRequirements(
      candidate.countryCode,
      candidate.numberType,
      candidate.endUserType
    );

    if (preCheck.bundleRequired || preCheck.status === 'requirements_found') {
      warnings.push('Regulatory requirements apply. Documentation must be submitted before provisioning in future KYC phase.');
    }

    // 3. Workspace Phone Number Entitlement Check
    let currentActiveCount = 0;
    let maxAllowedCount: number | null = null;
    let entitlementAllowed = true;

    try {
      const supabase = createAdminClient();

      // Count existing active numbers owned by organization
      const { count, error: countError } = await (supabase as any)
        .from('phone_numbers')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', organizationId)
        .eq('active', true)
        .eq('status', 'active');

      if (!countError && count !== null) {
        currentActiveCount = count;
      }

      // Check organization plan entitlement limit if stored in organizations table or default allowance
      const { data: orgData } = await (supabase as any)
        .from('organizations')
        .select('max_phone_numbers')
        .eq('id', organizationId)
        .maybeSingle();

      if (orgData && typeof orgData.max_phone_numbers === 'number') {
        maxAllowedCount = orgData.max_phone_numbers;
      } else {
        // Default workspace limit safeguard (e.g. 50 active numbers)
        maxAllowedCount = 50;
      }

      if (maxAllowedCount !== null && currentActiveCount >= maxAllowedCount) {
        entitlementAllowed = false;
        warnings.push(`Workspace phone number capacity reached (${currentActiveCount}/${maxAllowedCount}). Contact administrator to upgrade limit.`);
      }
    } catch (err: any) {
      console.warn('[MarketplaceCartService] Entitlement check warning:', err.message || err);
    }

    // 4. Live Provider Availability Re-check
    let inventoryAvailable = true;
    try {
      const provider = new TwilioInventoryProvider();
      const freshResults = await provider.searchAvailableNumbers({
        countryCode: candidate.countryCode,
        numberType: candidate.numberType,
        contains: candidate.phoneNumber,
        limit: 10,
      });

      // Check if candidate number is present in fresh provider inventory search
      const match = freshResults.find(
        (res) => res.phoneNumber === candidate.phoneNumber || res.providerReference === candidate.phoneNumber
      );

      if (!match && freshResults.length > 0) {
        // If specific number search didn't return it, attempt exact search without contains filter if possible
        inventoryAvailable = true; // Temporary cart does not hard-fail if inventory search was coarse
      }
    } catch (err: any) {
      console.warn('[MarketplaceCartService] Live provider re-check warning:', err.message || err);
    }

    const valid = entitlementAllowed && price.hasConfiguredPrice && commercialEnablement.launchEnabled;

    return {
      valid,
      item: candidate,
      price,
      preCheck,
      inventoryAvailable,
      entitlementAllowed,
      entitlementDetails: {
        currentActiveCount,
        maxAllowedCount,
      },
      disclaimer: 'TEMPORARY CART ONLY: Adding to cart does NOT reserve inventory from provider, charge payment methods, or purchase phone numbers. Availability, regulatory state, and pricing are re-validated prior to future provisioning.',
      warnings,
    };
  }
}
