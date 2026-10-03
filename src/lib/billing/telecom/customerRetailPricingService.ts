import { TelecomRetailRateCard } from '../types';

export interface CustomerRetailRateDisplayDTO {
  success: boolean;
  serviceType: string;
  direction: string;
  destinationPattern: string;
  destinationDescription?: string;
  retailRateMicro: number;
  retailRateMinorDisplay: string;
  currency: string;
  billingIncrementSeconds: number;
  minChargeableUnits: number;
}

export class CustomerRetailPricingService {
  /**
   * Sanitizes internal rate cards into customer-safe retail DTOs.
   * STRICT GUARANTEE: Removes all provider keys ('Twilio'), wholesale costs, markup basis points,
   * margin percentages, provider account IDs, and raw API responses.
   */
  public static toCustomerSafeDTO(rateCard: TelecomRetailRateCard): CustomerRetailRateDisplayDTO {
    const rateMicro = rateCard.retailRateMicro;
    const currency = (rateCard.currency || 'USD').toUpperCase();
    
    // Format display string ($0.0313 / min) using exact micro-unit to dollar conversion (1 USD = 1,000,000 micro-units)
    const dollars = rateMicro / 1_000_000;
    const formattedRate = `$${dollars.toFixed(4)} / min (${currency})`;

    return {
      success: true,
      serviceType: rateCard.serviceType,
      direction: rateCard.direction,
      destinationPattern: rateCard.destinationPattern || '*',
      destinationDescription: rateCard.destinationName || `Voice Destination (${rateCard.destinationPattern || '*'})`,
      retailRateMicro: rateMicro,
      retailRateMinorDisplay: formattedRate,
      currency,
      billingIncrementSeconds: rateCard.billingIncrementSeconds || 60,
      minChargeableUnits: rateCard.minChargeableUnits || 1,
    };
  }
}
