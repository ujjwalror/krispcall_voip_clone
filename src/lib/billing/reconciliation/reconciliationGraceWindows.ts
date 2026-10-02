import { FindingCategory } from './reconciliationTypes';

export interface GraceWindowConfig {
  [category: string]: number; // grace window duration in seconds
}

export const DEFAULT_GRACE_WINDOWS: Record<string, number> = {
  PAID_NOT_CAPTURED: 900, // 15 minutes (allows Stripe webhook network propagation)
  PAID_NOT_FUNDED: 300, // 5 minutes (allows DB trigger execution & transaction commit)
  STALE_PENDING_PAYMENT: 86400, // 24 hours (allows customer checkout completion window)
  APPROVED_REFUND_UNEXECUTED: 3600, // 1 hour (allows background refund worker queue)
  DISPUTE_HOLD_MISSING: 900, // 15 minutes (allows dispute webhook ingestion)
};

export class ReconciliationGraceWindowConfigurator {
  private config: Record<string, number>;

  constructor(customConfig?: Partial<Record<string, number>>) {
    this.config = {
      ...DEFAULT_GRACE_WINDOWS,
      ...(customConfig as Record<string, number>),
    };
  }

  getGraceWindowSeconds(category: FindingCategory | string): number {
    return this.config[category] ?? 0;
  }

  isWithinGraceWindow(
    category: FindingCategory | string,
    createdAt: Date | string | number,
    referenceTime: Date | string | number = new Date()
  ): boolean {
    const graceSeconds = this.getGraceWindowSeconds(category);
    if (graceSeconds <= 0) {
      return false;
    }

    const createdMs = new Date(createdAt).getTime();
    const refMs = new Date(referenceTime).getTime();

    if (isNaN(createdMs) || isNaN(refMs)) {
      return false;
    }

    const elapsedSeconds = Math.max(0, (refMs - createdMs) / 1000);
    return elapsedSeconds < graceSeconds;
  }
}
