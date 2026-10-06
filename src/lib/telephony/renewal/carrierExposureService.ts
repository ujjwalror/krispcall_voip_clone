import 'server-only';
import { ProviderCycleSource, ProviderCycleStatus, ProviderCycleMetadata } from './types';

export class CarrierExposureService {
  /**
   * Evaluates provider cycle metadata with explicit provenance checks.
   *
   * PROVENANCE RULES:
   * 1. PROVIDER_AUTHORITATIVE: Raw payload timestamp directly from provider API (e.g. Twilio dateCreated).
   * 2. PROVIDER_DERIVED_WITH_PROVEN_SEMANTICS: Saved from verified provisioning operation log with provider payload metadata.
   * 3. LOCAL_APPROXIMATION: Raw local DB created_at timestamp without verified provider provenance. MUST NOT masquerade as authoritative!
   * 4. UNKNOWN: Missing anchor or unparseable date. Fails closed.
   */
  static classifyProviderCycleAnchor(params: {
    rawAnchorDate?: string | Date | null;
    explicitSource?: ProviderCycleSource | null;
    hasProviderProvenance?: boolean;
  }): {
    anchorDate: string | null;
    source: ProviderCycleSource;
    status: ProviderCycleStatus;
  } {
    const { rawAnchorDate, explicitSource, hasProviderProvenance } = params;

    if (!rawAnchorDate) {
      return {
        anchorDate: null,
        source: 'UNKNOWN',
        status: 'unknown_requires_reconciliation',
      };
    }

    const parsed = new Date(rawAnchorDate);
    if (isNaN(parsed.getTime())) {
      return {
        anchorDate: null,
        source: 'UNKNOWN',
        status: 'unknown_requires_reconciliation',
      };
    }

    // Determine source & status based on explicit source and provenance flag
    if (explicitSource === 'PROVIDER_AUTHORITATIVE' || (hasProviderProvenance && explicitSource !== 'LOCAL_APPROXIMATION')) {
      return {
        anchorDate: parsed.toISOString(),
        source: 'PROVIDER_AUTHORITATIVE',
        status: 'verified',
      };
    }

    if (explicitSource === 'PROVIDER_DERIVED_WITH_PROVEN_SEMANTICS') {
      return {
        anchorDate: parsed.toISOString(),
        source: 'PROVIDER_DERIVED_WITH_PROVEN_SEMANTICS',
        status: 'verified',
      };
    }

    // Default for local created_at without proven provider provenance: LOCAL_APPROXIMATION -> FAILS CLOSED
    return {
      anchorDate: parsed.toISOString(),
      source: 'LOCAL_APPROXIMATION',
      status: 'unknown_requires_reconciliation',
    };
  }

  /**
   * ANCHOR-PRESERVING PERIOD CALCULATION (NO MONTHLY DRIFT).
   *
   * Calculates N periods forward from an explicit cycle anchor date, preserving the original
   * anchor day of month across month-length variations (e.g. 28th, 29th, 30th, 31st, Feb leap years).
   *
   * Example:
   * Anchor = Jan 31 @ 14:00 UTC
   * +1 Period (Feb) -> Feb 28 (or Feb 29 in leap year) @ 14:00 UTC (clamped to month end for Feb)
   * +2 Periods (March) -> March 31 @ 14:00 UTC (RETAINS 31st ANCHOR, NO SILENT DRIFT TO 28th!)
   */
  static calculateAnchorPreservedPeriodDate(
    cycleAnchorDateInput: string | Date,
    periodsForward: number
  ): string {
    const anchor = new Date(cycleAnchorDateInput);
    const anchorDay = anchor.getUTCDate();
    const anchorHours = anchor.getUTCHours();
    const anchorMinutes = anchor.getUTCMinutes();
    const anchorSeconds = anchor.getUTCSeconds();
    const anchorMs = anchor.getUTCMilliseconds();

    const startYear = anchor.getUTCFullYear();
    const startMonth = anchor.getUTCMonth();

    const targetTotalMonths = startMonth + periodsForward;
    const targetYear = startYear + Math.floor(targetTotalMonths / 12);
    const targetMonth = ((targetTotalMonths % 12) + 12) % 12;

    // Number of days in target month
    const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();

    // Clamp to days in month if anchorDay > daysInTargetMonth (e.g. Jan 31 -> Feb 28),
    // BUT preserve anchorDay as the true anchor for subsequent calculations!
    const effectiveDay = Math.min(anchorDay, daysInTargetMonth);

    return new Date(
      Date.UTC(targetYear, targetMonth, effectiveDay, anchorHours, anchorMinutes, anchorSeconds, anchorMs)
    ).toISOString();
  }

  /**
   * Calculates the next recurring provider exposure boundary from a cycle anchor,
   * preserving the original anchor day without drift.
   */
  static calculateNextProviderExposureBoundary(params: {
    cycleAnchorDate?: string | Date | null;
    explicitSource?: ProviderCycleSource | null;
    hasProviderProvenance?: boolean;
    asOfDate?: string | Date;
  }): ProviderCycleMetadata {
    const classification = this.classifyProviderCycleAnchor({
      rawAnchorDate: params.cycleAnchorDate,
      explicitSource: params.explicitSource,
      hasProviderProvenance: params.hasProviderProvenance,
    });

    if (!classification.anchorDate || classification.status === 'unknown_requires_reconciliation') {
      return {
        providerCycleAnchorAt: classification.anchorDate,
        providerNextExposureAt: null,
        providerCycleSource: classification.source,
        providerCycleStatus: 'unknown_requires_reconciliation',
      };
    }

    const anchorDate = new Date(classification.anchorDate);
    const asOfDate = params.asOfDate ? new Date(params.asOfDate) : new Date();

    let periodIndex = 0;
    let candidateIso = this.calculateAnchorPreservedPeriodDate(anchorDate, periodIndex);

    while (new Date(candidateIso).getTime() <= asOfDate.getTime()) {
      periodIndex++;
      candidateIso = this.calculateAnchorPreservedPeriodDate(anchorDate, periodIndex);
    }

    return {
      providerCycleAnchorAt: classification.anchorDate,
      providerNextExposureAt: candidateIso,
      providerCycleSource: classification.source,
      providerCycleStatus: classification.status,
    };
  }
}
