import 'server-only';
import { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { formatMinorUnitsToCurrency } from '@/lib/billing/currencyFormatter';

export interface CustomerNumberSubscriptionDTO {
  numberId: string;
  phoneNumber: string;
  friendlyName: string | null;
  countryCode: string;
  numberType: 'local' | 'mobile' | 'toll_free' | 'unknown';
  capabilities: {
    voice: boolean;
    sms: boolean;
    mms: boolean;
  };
  numberStatus: 'active' | 'inactive' | 'suspended' | 'released' | 'ported_out';
  billingStatus: 'active' | 'pending_reconciliation' | 'unbilled';
  monthlyRetailMinor: number | null;
  monthlyRetailFormatted: string | null;
  currency: string;
  purchasedAt: string;
}

export interface OrganizationNumberSubscriptionsSummaryDTO {
  success: boolean;
  totalActiveNumbers: number;
  totalMonthlyRetailMinor: number | null;
  formattedTotalMonthlyRetail: string;
  currency: string;
  hasMultipleCurrencies: boolean;
  hasUnpricedSubscriptions: boolean;
  unpricedCount: number;
  currenciesPresent: string[];
  numbers: CustomerNumberSubscriptionDTO[];
}

export class NumberSubscriptionService {
  /**
   * Resolves organization-owned numbers and authoritative contracted billable resource prices.
   * STRICTLY REDACTS all provider internal fields (Twilio SIDs, wholesale costs, margins, etc.).
   * DOES NOT use marketplace offer prices as a substitute for an unknown/missing contract price!
   */
  static async getOrganizationSubscriptions(
    organizationId: string,
    client?: SupabaseClient
  ): Promise<OrganizationNumberSubscriptionsSummaryDTO> {
    if (!organizationId) {
      throw new Error('INVALID_ORGANIZATION_ID: organizationId is required.');
    }

    const db = client || createAdminClient();

    // 1. Query owned phone numbers for tenant
    const { data: phoneNumbers, error: pnError } = await (db as any)
      .from('phone_numbers')
      .select(`
        id,
        organization_id,
        phone_number,
        friendly_name,
        active,
        status,
        country_code,
        number_type,
        capabilities_voice,
        capabilities_sms,
        capabilities_mms,
        created_at
      `)
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false });

    if (pnError) {
      console.error('[NumberSubscriptionService] Error fetching phone numbers:', pnError);
      throw new Error('Failed to fetch organization phone numbers.');
    }

    const numbersList = phoneNumbers || [];

    // 2. Query active billable resources for organization's phone numbers
    const { data: billableResources, error: brError } = await (db as any)
      .from('organization_billable_resources')
      .select('resource_id, contracted_retail_minor, currency, status, billing_interval')
      .eq('organization_id', organizationId)
      .eq('resource_type', 'phone_number')
      .eq('status', 'active');

    if (brError) {
      console.warn('[NumberSubscriptionService] Error fetching billable resources:', brError);
    }

    const billableMap = new Map<string, any>();
    (billableResources || []).forEach((br: any) => {
      if (br.resource_id) {
        billableMap.set(br.resource_id, br);
      }
    });

    const dtoList: CustomerNumberSubscriptionDTO[] = [];

    for (const pn of numbersList) {
      const countryCode = (pn.country_code || 'US').toUpperCase();
      const rawNumberType = (pn.number_type || 'local').toLowerCase();
      const numberType = ['local', 'mobile', 'toll_free'].includes(rawNumberType)
        ? (rawNumberType as 'local' | 'mobile' | 'toll_free')
        : 'unknown';

      // Customer-friendly status resolution from DB status
      let numberStatus: 'active' | 'inactive' | 'suspended' | 'released' | 'ported_out' = 'active';
      if (pn.status && ['active', 'inactive', 'suspended', 'released', 'ported_out'].includes(pn.status)) {
        numberStatus = pn.status as any;
      } else {
        numberStatus = pn.active ? 'active' : 'inactive';
      }

      // Authoritative billable resource matching & contracted price resolution
      let monthlyRetailMinor: number | null = null;
      let currency = 'USD';
      let billingStatus: 'active' | 'pending_reconciliation' | 'unbilled' = 'pending_reconciliation';

      const matchedResource = billableMap.get(pn.id);

      if (
        matchedResource &&
        matchedResource.contracted_retail_minor !== null &&
        matchedResource.contracted_retail_minor !== undefined
      ) {
        monthlyRetailMinor = Number(matchedResource.contracted_retail_minor);
        currency = (matchedResource.currency || 'USD').toUpperCase();
        billingStatus = 'active';
      } else {
        // CONTRACT PRICE SAFETY GUARANTEE:
        // Do NOT call marketplace offer pricing to manufacture a contract price for an owned number!
        // Return explicit pending/unavailable state.
        monthlyRetailMinor = null;
        currency = 'USD';
        billingStatus = 'pending_reconciliation';
      }

      const monthlyRetailFormatted = monthlyRetailMinor !== null
        ? formatMinorUnitsToCurrency(monthlyRetailMinor, currency)
        : null;

      dtoList.push({
        numberId: pn.id,
        phoneNumber: pn.phone_number,
        friendlyName: pn.friendly_name || null,
        countryCode,
        numberType,
        capabilities: {
          voice: Boolean(pn.capabilities_voice ?? true),
          sms: Boolean(pn.capabilities_sms ?? true),
          mms: Boolean(pn.capabilities_mms ?? false),
        },
        numberStatus,
        billingStatus,
        monthlyRetailMinor,
        monthlyRetailFormatted,
        currency,
        purchasedAt: pn.created_at || new Date().toISOString(),
      });
    }

    // Calculate Summary Totals for Active Numbers
    const activeDtoNumbers = dtoList.filter((n) => n.numberStatus === 'active');
    const pricedActiveNumbers = activeDtoNumbers.filter((n) => n.monthlyRetailMinor !== null);
    const unpricedActiveNumbers = activeDtoNumbers.filter((n) => n.monthlyRetailMinor === null);

    const currenciesPresent = Array.from(
      new Set(pricedActiveNumbers.map((n) => n.currency).filter(Boolean))
    );
    const hasMultipleCurrencies = currenciesPresent.length > 1;
    const hasUnpricedSubscriptions = unpricedActiveNumbers.length > 0;
    const unpricedCount = unpricedActiveNumbers.length;

    let totalMonthlyRetailMinor: number | null = 0;
    let formattedTotalMonthlyRetail = '$0.00 / month';

    if (activeDtoNumbers.length === 0) {
      totalMonthlyRetailMinor = 0;
      formattedTotalMonthlyRetail = '$0.00 / month';
    } else if (hasMultipleCurrencies) {
      totalMonthlyRetailMinor = null; // Cannot sum minor units across different currencies
      const breakdown = currenciesPresent
        .map((curr) => {
          const sum = pricedActiveNumbers
            .filter((n) => n.currency === curr)
            .reduce((acc, n) => acc + (n.monthlyRetailMinor || 0), 0);
          return formatMinorUnitsToCurrency(sum, curr);
        })
        .join(' + ');
      formattedTotalMonthlyRetail = `${breakdown} / month${hasUnpricedSubscriptions ? ' (Partial)' : ''}`;
    } else if (pricedActiveNumbers.length === 0) {
      // All active numbers have unknown/pending contracted prices - DO NOT TREAT AS $0!
      totalMonthlyRetailMinor = null;
      formattedTotalMonthlyRetail = 'Billing setup pending';
    } else {
      const mainCurrency = currenciesPresent[0] || 'USD';
      const sum = pricedActiveNumbers.reduce((acc, n) => acc + (n.monthlyRetailMinor || 0), 0);
      totalMonthlyRetailMinor = sum;
      const formattedSum = formatMinorUnitsToCurrency(sum, mainCurrency);
      formattedTotalMonthlyRetail = hasUnpricedSubscriptions
        ? `${formattedSum} / month (Known - ${unpricedCount} pending)`
        : `${formattedSum} / month`;
    }

    return {
      success: true,
      totalActiveNumbers: activeDtoNumbers.length,
      totalMonthlyRetailMinor,
      formattedTotalMonthlyRetail,
      currency: hasMultipleCurrencies ? 'MULTI' : (currenciesPresent[0] || 'USD'),
      hasMultipleCurrencies,
      hasUnpricedSubscriptions,
      unpricedCount,
      currenciesPresent,
      numbers: dtoList,
    };
  }
}
