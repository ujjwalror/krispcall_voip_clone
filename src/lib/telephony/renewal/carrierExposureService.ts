import 'server-only';
import { CarrierExposureSource } from './types';

export class CarrierExposureService {
  /**
   * Calculates the next carrier exposure (billing charge boundary) for a phone number.
   * DYNAMIC PER-NUMBER RECURRING CYCLE CALCULATION.
   *
   * Example:
   * A number acquired on Oct 6 @ 14:30 UTC recurs on Nov 6 @ 14:30 UTC, Dec 6 @ 14:30 UTC, etc.
   * A number acquired on Oct 21 @ 09:15 UTC recurs on Nov 21 @ 09:15 UTC, Dec 21 @ 09:15 UTC, etc.
   *
   * STRICT GUARANTEE: NO global month-end or calendar-1st assumption is ever applied!
   */
  static calculateNextProviderExposureBoundary(
    anchorDateInput: string | Date | null | undefined,
    asOfDateInput?: string | Date
  ): {
    nextExposureAt: string | null;
    exposureSource: CarrierExposureSource;
    cycleAnchorAt: string | null;
  } {
    if (!anchorDateInput) {
      return {
        nextExposureAt: null,
        exposureSource: 'unknown_requires_reconciliation',
        cycleAnchorAt: null,
      };
    }

    const anchorDate = new Date(anchorDateInput);
    if (isNaN(anchorDate.getTime())) {
      return {
        nextExposureAt: null,
        exposureSource: 'unknown_requires_reconciliation',
        cycleAnchorAt: null,
      };
    }

    const asOfDate = asOfDateInput ? new Date(asOfDateInput) : new Date();

    // Advance monthly cycles from anchor date until next exposure is in the future relative to asOfDate
    let exposureCandidate = new Date(anchorDate.getTime());

    while (exposureCandidate.getTime() <= asOfDate.getTime()) {
      // Add 1 month dynamically preserving day of month
      const currentYear = exposureCandidate.getFullYear();
      const currentMonth = exposureCandidate.getMonth();
      const targetMonth = (currentMonth + 1) % 12;
      const targetYear = currentYear + Math.floor((currentMonth + 1) / 12);

      // Handle month-length variations gracefully (e.g. Jan 31 -> Feb 28/29)
      const originalDay = anchorDate.getDate();
      const daysInTargetMonth = new Date(targetYear, targetMonth + 1, 0).getDate();
      const safeDay = Math.min(originalDay, daysInTargetMonth);

      exposureCandidate = new Date(
        Date.UTC(
          targetYear,
          targetMonth,
          safeDay,
          anchorDate.getUTCHours(),
          anchorDate.getUTCMinutes(),
          anchorDate.getUTCSeconds(),
          anchorDate.getUTCMilliseconds()
        )
      );
    }

    return {
      nextExposureAt: exposureCandidate.toISOString(),
      exposureSource: 'safely_derived_provisioning_date',
      cycleAnchorAt: anchorDate.toISOString(),
    };
  }

  /**
   * Computes remaining carrier exposure window in hours relative to current time.
   */
  static getHoursUntilProviderExposure(
    nextExposureAtIso: string | null,
    asOfDateInput?: string | Date
  ): number | null {
    if (!nextExposureAtIso) return null;
    const target = new Date(nextExposureAtIso).getTime();
    const now = asOfDateInput ? new Date(asOfDateInput).getTime() : Date.now();
    return Math.floor((target - now) / (1000 * 60 * 60));
  }
}
