import { parsePhoneNumber, CountryCode } from 'libphonenumber-js';
import { SupabaseClient } from '@supabase/supabase-js';
import { Database } from '@/lib/types/database.types';
import {
  DestinationRiskClassification,
  DestinationRiskEvaluation,
  TelecomServiceCategory,
} from './types';

export interface OrgGeographicPolicy {
  allowedCountries?: string[] | null;
  blockedCountries?: string[] | null;
  maxCeilingOverrideSeconds?: number;
}

export class DestinationRiskService {
  /**
   * Fetches organization geographic policy controls from organization_billing_controls.
   */
  public static async getOrgGeographicPolicy(
    client: SupabaseClient | null,
    organizationId: string
  ): Promise<OrgGeographicPolicy | null> {
    if (!client || !organizationId) return null;

    try {
      const { data, error } = await client
        .from('organization_billing_controls')
        .select('*')
        .eq('organization_id', organizationId)
        .maybeSingle();

      if (error || !data) {
        return null;
      }

      return {
        allowedCountries: data.allowed_destination_countries,
        blockedCountries: data.blocked_destination_countries,
        maxCeilingOverrideSeconds: typeof data.voice_risk_ceiling_seconds === 'number'
          ? data.voice_risk_ceiling_seconds
          : undefined,
      };
    } catch {
      return null;
    }
  }

  /**
   * Recognized emergency numbers across target jurisdictions (US/CA: 911, EU/UK/Global: 112, UK: 999, AU: 000, US Test: 933)
   */
  private static readonly EMERGENCY_NUMBERS: Record<string, '000' | '112' | '911' | '999' | 'other'> = {
    '000': '000',
    '111': 'other', // NZ emergency
    '112': '112',
    '911': '911',
    '999': '999',
    '933': 'other', // Twilio E911 test number
    '08': 'other',  // AU emergency test/special
    '106': 'other', // AU text emergency relay
    '110': 'other', // JP/CN police
    '119': 'other', // JP/CN fire/ambulance
  };

  /**
   * Recognized satellite and non-geographic high-risk telecommunications prefixes.
   * Default classification: BLOCKED or RESTRICTED to protect shared carrier balance.
   */
  private static readonly HIGH_RISK_PREFIXES: Record<string, { category: TelecomServiceCategory; defaultClassification: DestinationRiskClassification; reason: string }> = {
    '+870': { category: 'satellite', defaultClassification: 'BLOCKED', reason: 'Inmarsat Global Satellite Service' },
    '+881': { category: 'satellite', defaultClassification: 'BLOCKED', reason: 'Global Mobile Satellite System (GMSS / Iridium)' },
    '+8816': { category: 'satellite', defaultClassification: 'BLOCKED', reason: 'Iridium Satellite Network' },
    '+8817': { category: 'satellite', defaultClassification: 'BLOCKED', reason: 'Iridium Satellite Network' },
    '+8818': { category: 'satellite', defaultClassification: 'BLOCKED', reason: 'Globalstar Satellite Network' },
    '+882': { category: 'special_services', defaultClassification: 'RESTRICTED', reason: 'International Networks (shared code)' },
    '+88216': { category: 'satellite', defaultClassification: 'BLOCKED', reason: 'Thuraya Satellite Network' },
    '+883': { category: 'special_services', defaultClassification: 'RESTRICTED', reason: 'International Networks (high-cost)' },
    '+878': { category: 'special_services', defaultClassification: 'RESTRICTED', reason: 'Universal Personal Telecommunications' },
    // Premium toll-fraud high-cost islands/hotspots
    '+247': { category: 'premium_rate', defaultClassification: 'RESTRICTED', reason: 'Ascension Island high-cost destination' },
    '+290': { category: 'premium_rate', defaultClassification: 'RESTRICTED', reason: 'Saint Helena high-cost destination' },
    '+674': { category: 'premium_rate', defaultClassification: 'RESTRICTED', reason: 'Nauru high-cost destination' },
    '+688': { category: 'premium_rate', defaultClassification: 'RESTRICTED', reason: 'Tuvalu high-cost destination' },
    '+232': { category: 'premium_rate', defaultClassification: 'RESTRICTED', reason: 'Sierra Leone elevated toll risk prefix' },
    '+252': { category: 'premium_rate', defaultClassification: 'RESTRICTED', reason: 'Somalia elevated toll risk prefix' },
    '+376': { category: 'geographic_landline', defaultClassification: 'RESTRICTED', reason: 'Andorra elevated carrier rate' },
  };

  /**
   * Identifies if a destination is an emergency number.
   * Emergency numbers must NEVER be dispatched as ordinary international PSTN.
   */
  public static isEmergencyDestination(destination: string): { isEmergency: boolean; emergencyType?: '000' | '112' | '911' | '999' | 'other' } {
    const cleaned = (destination || '').trim().replace(/[^\d+]/g, '');
    const plainDigits = cleaned.replace(/^\+/, '');

    // 1. Direct emergency number match (e.g. 911, 112, 999, 000, 933, 111)
    if (this.EMERGENCY_NUMBERS[plainDigits]) {
      return { isEmergency: true, emergencyType: this.EMERGENCY_NUMBERS[plainDigits] };
    }

    // 2. Check country-prefixed emergency numbers (e.g. +1911, +1933, +61000, +44999, +44112, +64111)
    const countryPrefixes = ['1', '61', '44', '64'];
    for (const cp of countryPrefixes) {
      if (plainDigits.startsWith(cp)) {
        const remainder = plainDigits.substring(cp.length);
        if (this.EMERGENCY_NUMBERS[remainder]) {
          return { isEmergency: true, emergencyType: this.EMERGENCY_NUMBERS[remainder] };
        }
      }
    }

    return { isEmergency: false };
  }

  /**
   * Evaluates destination risk authoritatively before carrier dispatch.
   */
  public static evaluateDestination(
    destination: string,
    orgPolicy?: OrgGeographicPolicy | null
  ): DestinationRiskEvaluation {
    const rawClean = (destination || '').trim();

    // 1. EMERGENCY NUMBER POLICY GATEWAY
    const emergencyCheck = this.isEmergencyDestination(rawClean);
    if (emergencyCheck.isEmergency) {
      return {
        destination: rawClean,
        countryCode: null,
        e164Prefix: rawClean,
        serviceCategory: 'emergency',
        classification: 'BLOCKED',
        isEmergency: true,
        emergencyType: emergencyCheck.emergencyType,
        riskRule: 'EMERGENCY_DESTINATION_GATE',
        reason: 'EMERGENCY_DESTINATION_SPECIALIST_REVIEW_REQUIRED: Emergency calling (911/112/000/999) is not supported on VoIP Hub. Regulatory certification required.',
        maxProviderExposureSeconds: 0,
        requiresManualReview: false,
      };
    }

    // 2. PARSE DESTINATION AS E.164
    let parsedCountry: CountryCode | null = null;
    let normalized = rawClean;
    let serviceCategory: TelecomServiceCategory = 'unknown';

    try {
      const phoneNumber = parsePhoneNumber(rawClean.startsWith('+') ? rawClean : `+${rawClean}`);
      if (phoneNumber) {
        parsedCountry = phoneNumber.country || null;
        normalized = phoneNumber.number;

        // Categorize by phone number type if known
        const type = phoneNumber.getType();
        if (type === 'MOBILE') serviceCategory = 'mobile';
        else if (type === 'FIXED_LINE') serviceCategory = 'geographic_landline';
        else if (type === 'TOLL_FREE') serviceCategory = 'toll_free';
        else if (type === 'PREMIUM_RATE') serviceCategory = 'premium_rate';
        else if (type === 'SHARED_COST') serviceCategory = 'special_services';
        else serviceCategory = 'unknown';
      }
    } catch {
      // Unparseable number format
    }

    // 3. CHECK KNOWN HIGH-RISK / SATELLITE PREFIXES
    for (const [prefix, config] of Object.entries(this.HIGH_RISK_PREFIXES)) {
      if (normalized.startsWith(prefix)) {
        return {
          destination: normalized,
          countryCode: parsedCountry,
          e164Prefix: prefix,
          serviceCategory: config.category,
          classification: config.defaultClassification,
          isEmergency: false,
          riskRule: config.defaultClassification === 'RESTRICTED' ? 'HIGH_RISK_PREFIX_RESTRICTED' : 'HIGH_RISK_PREFIX_BLOCKED',
          reason: config.reason,
          maxProviderExposureSeconds: config.defaultClassification === 'RESTRICTED' ? 300 : 0,
          requiresManualReview: config.defaultClassification === 'RESTRICTED',
        };
      }
    }

    // 4. ORGANIZATION-SPECIFIC GEOGRAPHIC PERMISSION CHECK
    if (orgPolicy) {
      const ISO_ALPHA2_REGEX = /^[A-Za-z]{2}$/;

      // 4a. Validate Policy Integrity: Blocked Destination Countries
      let normalizedBlocked: string[] | null = null;
      if (orgPolicy.blockedCountries !== undefined && orgPolicy.blockedCountries !== null) {
        if (!Array.isArray(orgPolicy.blockedCountries)) {
          return {
            destination: normalized,
            countryCode: parsedCountry,
            e164Prefix: normalized.substring(0, 3),
            serviceCategory,
            classification: 'BLOCKED',
            isEmergency: false,
            riskRule: 'DESTINATION_COUNTRY_POLICY_INVALID',
            reason: 'Organization blocked_destination_countries policy is malformed. Failing closed.',
            maxProviderExposureSeconds: 0,
            requiresManualReview: false,
          };
        }
        normalizedBlocked = [];
        for (const code of orgPolicy.blockedCountries) {
          if (typeof code !== 'string' || !ISO_ALPHA2_REGEX.test(code.trim())) {
            return {
              destination: normalized,
              countryCode: parsedCountry,
              e164Prefix: normalized.substring(0, 3),
              serviceCategory,
              classification: 'BLOCKED',
              isEmergency: false,
              riskRule: 'DESTINATION_COUNTRY_POLICY_INVALID',
              reason: `Organization blocked_destination_countries contains invalid country code: "${code}". Failing closed.`,
              maxProviderExposureSeconds: 0,
              requiresManualReview: false,
            };
          }
          normalizedBlocked.push(code.trim().toUpperCase());
        }
      }

      // 4b. Validate Policy Integrity: Allowed Destination Countries
      let normalizedAllowed: string[] | null = null;
      if (orgPolicy.allowedCountries !== undefined && orgPolicy.allowedCountries !== null) {
        if (!Array.isArray(orgPolicy.allowedCountries)) {
          return {
            destination: normalized,
            countryCode: parsedCountry,
            e164Prefix: normalized.substring(0, 3),
            serviceCategory,
            classification: 'BLOCKED',
            isEmergency: false,
            riskRule: 'DESTINATION_COUNTRY_POLICY_INVALID',
            reason: 'Organization allowed_destination_countries policy is malformed. Failing closed.',
            maxProviderExposureSeconds: 0,
            requiresManualReview: false,
          };
        }
        normalizedAllowed = [];
        for (const code of orgPolicy.allowedCountries) {
          if (typeof code !== 'string' || !ISO_ALPHA2_REGEX.test(code.trim())) {
            return {
              destination: normalized,
              countryCode: parsedCountry,
              e164Prefix: normalized.substring(0, 3),
              serviceCategory,
              classification: 'BLOCKED',
              isEmergency: false,
              riskRule: 'DESTINATION_COUNTRY_POLICY_INVALID',
              reason: `Organization allowed_destination_countries contains invalid country code: "${code}". Failing closed.`,
              maxProviderExposureSeconds: 0,
              requiresManualReview: false,
            };
          }
          normalizedAllowed.push(code.trim().toUpperCase());
        }
      }

      const hasPolicy = normalizedBlocked !== null || normalizedAllowed !== null;

      // 4c. Rule 7: Fail-Closed for Unresolved Destination Country if Policy is Configured
      if (hasPolicy && !parsedCountry) {
        return {
          destination: normalized,
          countryCode: null,
          e164Prefix: normalized.substring(0, 4),
          serviceCategory: 'unknown',
          classification: 'BLOCKED',
          isEmergency: false,
          riskRule: 'DESTINATION_COUNTRY_UNRESOLVED',
          reason: 'Destination country could not be resolved and organization geographic policy is configured. Failing closed.',
          maxProviderExposureSeconds: 0,
          requiresManualReview: false,
        };
      }

      if (parsedCountry) {
        const countryUpper = parsedCountry.toUpperCase();

        // 4d. Rule 2 & Rule 4: Denylist Check (Blocked Wins over Allowed)
        if (normalizedBlocked && normalizedBlocked.includes(countryUpper)) {
          return {
            destination: normalized,
            countryCode: parsedCountry,
            e164Prefix: normalized.substring(0, 3),
            serviceCategory,
            classification: 'BLOCKED',
            isEmergency: false,
            riskRule: 'DESTINATION_COUNTRY_BLOCKED',
            reason: `Destination country ${countryUpper} is blocked by organization geographic security policy.`,
            maxProviderExposureSeconds: 0,
            requiresManualReview: false,
          };
        }

        // 4e. Rule 3: Allowlist Check
        // NULL: No restriction
        // Empty array: Allow NO destination countries
        // Non-empty array: Destination must appear in the allowlist
        if (normalizedAllowed !== null) {
          if (normalizedAllowed.length === 0) {
            return {
              destination: normalized,
              countryCode: parsedCountry,
              e164Prefix: normalized.substring(0, 3),
              serviceCategory,
              classification: 'BLOCKED',
              isEmergency: false,
              riskRule: 'DESTINATION_COUNTRY_NOT_ALLOWED',
              reason: `Destination country ${countryUpper} is not allowed: organization allowlist is empty (all outbound destinations blocked).`,
              maxProviderExposureSeconds: 0,
              requiresManualReview: false,
            };
          }

          if (!normalizedAllowed.includes(countryUpper)) {
            return {
              destination: normalized,
              countryCode: parsedCountry,
              e164Prefix: normalized.substring(0, 3),
              serviceCategory,
              classification: 'BLOCKED',
              isEmergency: false,
              riskRule: 'DESTINATION_COUNTRY_NOT_ALLOWED',
              reason: `Destination country ${countryUpper} is not present in organization allowed destinations list.`,
              maxProviderExposureSeconds: 0,
              requiresManualReview: false,
            };
          }
        }
      }
    }

    // 5. CONSERVATIVE UNKNOWN DESTINATIONS (No policy configured, but unresolvable country)
    if (!parsedCountry) {
      return {
        destination: normalized,
        countryCode: null,
        e164Prefix: normalized.substring(0, 4),
        serviceCategory: 'unknown',
        classification: 'RESTRICTED',
        isEmergency: false,
        riskRule: 'DESTINATION_COUNTRY_UNCLASSIFIED',
        reason: 'Unknown or unclassified international destination. Handled conservatively.',
        maxProviderExposureSeconds: 300,
        requiresManualReview: true,
      };
    }

    // 6. STANDARD ALLOWED DESTINATIONS
    return {
      destination: normalized,
      countryCode: parsedCountry,
      e164Prefix: normalized.substring(0, 3),
      serviceCategory,
      classification: 'ALLOWED',
      isEmergency: false,
      riskRule: 'DESTINATION_ALLOWED',
      reason: `Standard destination in ${parsedCountry}.`,
      maxProviderExposureSeconds: 3600,
      requiresManualReview: false,
    };
  }

  /**
   * Computes rate-aware and risk-aware provider ceiling for Twilio TwiML <Dial timeLimit>.
   * Prevents high-cost destinations from receiving catastrophic 3,600s ceilings.
   *
   * Rate Tiers (micro USD per minute):
   * - Normal / Domestic rate (< $0.15/min = 150,000 micro): Standard ceiling (e.g. 3,600s)
   * - Elevated rate ($0.15 - $0.50/min = 150,000 - 500,000 micro): Reduced ceiling (900s / 15 min)
   * - High-cost rate ($0.50 - $2.00/min = 500,000 - 2,000,000 micro): Tight ceiling (300s / 5 min)
   * - Extreme / Satellite rate (> $2.00/min): Ultra-tight ceiling (180s / 3 min)
   */
  public static calculateRiskAwareProviderCeiling(
    retailRateMicro: number,
    classification: DestinationRiskClassification = 'ALLOWED',
    configuredMaxSeconds: number = 3600
  ): number {
    if (classification === 'BLOCKED') {
      return 0;
    }

    let rateBasedCapSeconds = configuredMaxSeconds;

    if (retailRateMicro > 2_000_000) {
      // > $2.00 / min
      rateBasedCapSeconds = 180; // 3 minutes
    } else if (retailRateMicro > 500_000) {
      // > $0.50 / min
      rateBasedCapSeconds = 300; // 5 minutes
    } else if (retailRateMicro > 150_000) {
      // > $0.15 / min
      rateBasedCapSeconds = 900; // 15 minutes
    } else {
      // Normal domestic/low-cost: standard ceiling
      rateBasedCapSeconds = configuredMaxSeconds;
    }

    if (classification === 'RESTRICTED') {
      // Restricted destinations must not exceed 300s ceiling regardless of rate
      rateBasedCapSeconds = Math.min(rateBasedCapSeconds, 300);
    }

    return Math.min(configuredMaxSeconds, rateBasedCapSeconds);
  }
}
