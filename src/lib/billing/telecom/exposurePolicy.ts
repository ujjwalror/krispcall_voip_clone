import { TelecomRetailRateCard } from '../types';
import { TelecomRatingService } from './telecomRatingService';

export type TelecomPrepaidEnforcementMode = 'disabled' | 'shadow_log' | 'enforce';

export interface ExposurePolicyConfig {
  initialExposureSeconds: number;
  maxInitialExposureSeconds: number;
  enforcementMode: TelecomPrepaidEnforcementMode;
}

export interface CalculatedExposure {
  initialDurationSeconds: number;
  billingIncrementSeconds: number;
  minChargeableUnits: number;
  billableIncrementsCount: number;
  requiredFundedMinor: number;
  enforcementMode: TelecomPrepaidEnforcementMode;
}

export class ExposurePolicyError extends Error {
  code: string;

  constructor(message: string, code: string = 'INVALID_EXPOSURE_POLICY_CONFIG') {
    super(message);
    this.name = 'ExposurePolicyError';
    this.code = code;
  }
}

export class ExposurePolicy {
  /**
   * Resolves policy configuration from environment or provided parameters.
   */
  public static getConfig(overrides?: Partial<ExposurePolicyConfig>): ExposurePolicyConfig {
    const rawInitial = overrides?.initialExposureSeconds ?? 
      (process.env.TELECOM_VOICE_INITIAL_EXPOSURE_SECONDS ? parseInt(process.env.TELECOM_VOICE_INITIAL_EXPOSURE_SECONDS, 10) : 300);

    const rawMax = overrides?.maxInitialExposureSeconds ?? 
      (process.env.TELECOM_VOICE_MAX_INITIAL_EXPOSURE_SECONDS ? parseInt(process.env.TELECOM_VOICE_MAX_INITIAL_EXPOSURE_SECONDS, 10) : 3600);

    const rawMode = overrides?.enforcementMode ?? 
      ((process.env.TELECOM_PREPAID_ENFORCEMENT_MODE as TelecomPrepaidEnforcementMode) || 'shadow_log');

    return {
      initialExposureSeconds: rawInitial,
      maxInitialExposureSeconds: rawMax,
      enforcementMode: rawMode,
    };
  }

  /**
   * Validates policy configuration invariants.
   * Throws ExposurePolicyError if invalid in enforce mode.
   */
  public static validateConfig(config: ExposurePolicyConfig): void {
    const { initialExposureSeconds, maxInitialExposureSeconds, enforcementMode } = config;

    if (!['disabled', 'shadow_log', 'enforce'].includes(enforcementMode)) {
      throw new ExposurePolicyError(
        `Invalid enforcement mode: "${enforcementMode}". Must be 'disabled', 'shadow_log', or 'enforce'.`,
        'INVALID_EXPOSURE_POLICY_CONFIG'
      );
    }

    if (
      !Number.isInteger(initialExposureSeconds) ||
      initialExposureSeconds <= 0 ||
      !Number.isInteger(maxInitialExposureSeconds) ||
      maxInitialExposureSeconds <= 0
    ) {
      if (enforcementMode === 'enforce') {
        throw new ExposurePolicyError(
          `Invalid exposure policy config: duration seconds must be positive integers (initial: ${initialExposureSeconds}, max: ${maxInitialExposureSeconds}).`,
          'INVALID_EXPOSURE_POLICY_CONFIG'
        );
      }
    }

    if (initialExposureSeconds > maxInitialExposureSeconds) {
      if (enforcementMode === 'enforce') {
        throw new ExposurePolicyError(
          `Invalid exposure policy config: initial exposure (${initialExposureSeconds}s) exceeds max exposure (${maxInitialExposureSeconds}s).`,
          'INVALID_EXPOSURE_POLICY_CONFIG'
        );
      }
    }
  }

  /**
   * Calculates safe rate-aware initial exposure duration and required minor-unit funded reservation hold.
   * Strict Maximum Invariant: The computed increment-aligned initial duration must NEVER exceed maxInitialExposureSeconds.
   */
  public static calculateInitialExposure(
    rateCard: TelecomRetailRateCard,
    configOverrides?: Partial<ExposurePolicyConfig>
  ): CalculatedExposure {
    const config = this.getConfig(configOverrides);
    this.validateConfig(config);

    const increment = Math.max(1, rateCard.billingIncrementSeconds || 60);
    const minUnits = Math.max(1, rateCard.minChargeableUnits || 1);

    const targetSeconds = config.initialExposureSeconds;

    // Billing increments required to safely cover target seconds
    const incrementsNeeded = Math.ceil(targetSeconds / increment);
    const billableIncrementsCount = Math.max(minUnits, incrementsNeeded);

    // Bounded duration in exact integer billing increments
    const initialDurationSeconds = billableIncrementsCount * increment;

    // STRICT INVARIANT CHECK: Increment-aligned duration MUST NOT exceed maxInitialExposureSeconds
    if (initialDurationSeconds > config.maxInitialExposureSeconds) {
      if (config.enforcementMode === 'enforce') {
        throw new ExposurePolicyError(
          `Calculated initial exposure duration (${initialDurationSeconds}s) exceeds configured maximum initial exposure (${config.maxInitialExposureSeconds}s).`,
          'INVALID_EXPOSURE_POLICY_CONFIG'
        );
      }
    }

    // Integer-safe required funded minor units (cents)
    const requiredFundedMinor = TelecomRatingService.calculateEstimatedExposureMinor(
      rateCard,
      initialDurationSeconds
    );

    return {
      initialDurationSeconds,
      billingIncrementSeconds: increment,
      minChargeableUnits: minUnits,
      billableIncrementsCount,
      requiredFundedMinor,
      enforcementMode: config.enforcementMode,
    };
  }
}
