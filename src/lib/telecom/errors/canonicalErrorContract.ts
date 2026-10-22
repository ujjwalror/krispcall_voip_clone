import 'server-only';
import { NextResponse } from 'next/server';

export type CanonicalErrorCode =
  | 'NO_NUMBER_SLOT_AVAILABLE'
  | 'OVER_ENTITLED'
  | 'COMPLIANCE_REQUIRED'
  | 'CAPABILITY_NOT_USABLE'
  | 'PROVIDER_ASSIGNMENT_REQUIRED'
  | 'PROVIDER_OUTCOME_UNKNOWN'
  | 'INVENTORY_VANISHED'
  | 'ACTIVE_TRAFFIC_BLOCKS_RELEASE'
  | 'PORT_OUT_LOCKED'
  | 'STEP_UP_AUTH_REQUIRED'
  | 'MANUAL_REVIEW_REQUIRED'
  | 'QUOTE_EXPIRED'
  | 'TAMPERED_QUOTE'
  | 'INVALID_ROUTING_TARGET'
  | 'INSUFFICIENT_FUNDS'
  | 'PROTECTED_PILOT_QUARANTINE'
  | 'TENANT_MISMATCH'
  | 'OPERATION_IN_FLIGHT'
  | 'ROLE_NOT_AUTHORIZED'
  | 'INTERNAL_ERROR';

export interface CanonicalSafeErrorResponse {
  success: false;
  errorCode: CanonicalErrorCode | string;
  message: string;
  httpStatus: number;
  isRetryable: boolean;
  recommendedAction: string;
  reconciliationRequired?: boolean;
  operationId?: string;
  details?: Record<string, any>;
}

interface ErrorMappingSpec {
  status: number;
  message: string;
  isRetryable: boolean;
  recommendedAction: string;
  reconciliationRequired?: boolean;
}

const ERROR_TAXONOMY: Record<string, ErrorMappingSpec> = {
  NO_NUMBER_SLOT_AVAILABLE: {
    status: 403,
    message: 'Your workspace has reached its operational phone number capacity limit.',
    isRetryable: false,
    recommendedAction: 'Review workspace account limits or contact administrator/support.',
  },
  OVER_ENTITLED: {
    status: 403,
    message: 'Your workspace has exceeded its permitted resource capacity.',
    isRetryable: false,
    recommendedAction: 'Review workspace resource allocations or contact support.',
  },
  COMPLIANCE_REQUIRED: {
    status: 400,
    message: 'Regulatory verification is required for this country or number type before activation.',
    isRetryable: false,
    recommendedAction: 'Submit required business registration or identity documents in Regulatory Verification.',
  },
  CAPABILITY_NOT_USABLE: {
    status: 403,
    message: 'The selected phone number is not currently provisioned or configured for this capability.',
    isRetryable: false,
    recommendedAction: 'Verify line configuration or choose a phone number with the required service enabled.',
  },
  PROVIDER_ASSIGNMENT_REQUIRED: {
    status: 500,
    message: 'Dedicated customer telecom provider subaccount is being provisioned for your workspace.',
    isRetryable: true,
    recommendedAction: 'Wait 60 seconds and refresh your workspace. Contact support if provisioning delays persist.',
  },
  PROVIDER_OUTCOME_UNKNOWN: {
    status: 504,
    message: 'Carrier mutation dispatched but confirmation is pending. Operation preserved safely.',
    isRetryable: false,
    reconciliationRequired: true,
    recommendedAction: 'Do not re-attempt purchase or release. Background reconciliation will finalize carrier state automatically.',
  },
  INVENTORY_VANISHED: {
    status: 409,
    message: 'The selected carrier inventory was claimed by another customer. Zero charges incurred.',
    isRetryable: false,
    recommendedAction: 'Refresh search results and select an alternative phone number.',
  },
  ACTIVE_TRAFFIC_BLOCKS_RELEASE: {
    status: 409,
    message: 'Cannot release this phone number while active calls or in-flight messages are connected.',
    isRetryable: true,
    recommendedAction: 'Terminate active voice calls and allow in-flight SMS to settle before initiating release.',
  },
  PORT_OUT_LOCKED: {
    status: 403,
    message: 'Port Freeze security lock is active on this line to prevent unauthorized carrier transfer.',
    isRetryable: false,
    recommendedAction: 'Unlock carrier port-out in Security Settings using two-factor authentication.',
  },
  STEP_UP_AUTH_REQUIRED: {
    status: 401,
    message: 'Step-up multi-factor authentication is required for this sensitive operational action.',
    isRetryable: false,
    recommendedAction: 'Complete two-factor authentication prompt to obtain an authorized operation token.',
  },
  MANUAL_REVIEW_REQUIRED: {
    status: 422,
    message: 'Carrier transfer or regulatory verification requires operational review.',
    isRetryable: false,
    recommendedAction: 'Check case notes or contact carrier operations desk with your reference ID.',
  },
  QUOTE_EXPIRED: {
    status: 400,
    message: 'The pricing quote has expired. Currency pricing must be recalculated.',
    isRetryable: false,
    recommendedAction: 'Refresh search results to retrieve a fresh authoritative pricing quote.',
  },
  TAMPERED_QUOTE: {
    status: 400,
    message: 'The supplied pricing quote signature or parameters were invalid.',
    isRetryable: false,
    recommendedAction: 'Retrieve a new quote through the marketplace checkout interface.',
  },
  INVALID_ROUTING_TARGET: {
    status: 400,
    message: 'The specified routing destination is invalid, inactive, or belongs to another organization.',
    isRetryable: false,
    recommendedAction: 'Select an active user, team queue, or IVR menu from your workspace.',
  },
  INSUFFICIENT_FUNDS: {
    status: 402,
    message: 'Your telecom usage wallet balance is insufficient for this communication.',
    isRetryable: false,
    recommendedAction: 'Add prepaid usage credits to your workspace wallet in Billing settings.',
  },
  PROTECTED_PILOT_QUARANTINE: {
    status: 403,
    message: 'This phone number is a permanently protected system pilot line and cannot be modified or released.',
    isRetryable: false,
    recommendedAction: 'Action blocked by immutable system safety policy.',
  },
  TENANT_MISMATCH: {
    status: 403,
    message: 'Access denied: Target telecom resource does not belong to your organization.',
    isRetryable: false,
    recommendedAction: 'Verify that you are logged into the correct workspace.',
  },
  OPERATION_IN_FLIGHT: {
    status: 409,
    message: 'An existing operation is already processing for this phone number.',
    isRetryable: false,
    recommendedAction: 'Wait for the current operation to complete before initiating another change.',
  },
  ROLE_NOT_AUTHORIZED: {
    status: 403,
    message: 'Insufficient permissions. This operation requires Organization Owner or Admin privileges.',
    isRetryable: false,
    recommendedAction: 'Contact your organization administrator to perform this action.',
  },
};

export interface CanonicalErrorOptions {
  customCode?: string;
  customMessage?: string;
  httpStatus?: number;
  operationId?: string;
  reconciliationRequired?: boolean;
}

/**
 * Sanitizes any raw exception or error code into a customer-safe canonical DTO.
 * Guarantees zero leakage of SQL errors, provider secrets, auth tokens, internal SIDs, or stack traces.
 */
export function sanitizeCanonicalError(
  errorOrCode: any,
  fallbackOrOptions: string | CanonicalErrorOptions = 'An unexpected error occurred while processing the telecom request.'
): CanonicalSafeErrorResponse {
  const options: CanonicalErrorOptions =
    typeof fallbackOrOptions === 'string'
      ? { customMessage: fallbackOrOptions }
      : fallbackOrOptions || {};

  const fallbackMessage = options.customMessage || 'An unexpected error occurred while processing the telecom request.';

  let rawCode = options.customCode || '';
  let rawMessage = '';
  let opId: string | undefined = options.operationId;

  if (typeof errorOrCode === 'string') {
    if (!rawCode) rawCode = errorOrCode;
    rawMessage = errorOrCode;
  } else if (errorOrCode && typeof errorOrCode === 'object') {
    if (!rawCode) rawCode = errorOrCode.code || errorOrCode.errorCode || '';
    rawMessage = errorOrCode.message || errorOrCode.errorMessage || '';
    if (!opId) opId = errorOrCode.operationId;
  }

  // Detect canonical error code in raw code or message string
  let matchedCode: CanonicalErrorCode | null = null;
  for (const knownCode of Object.keys(ERROR_TAXONOMY)) {
    if (
      rawCode === knownCode ||
      rawMessage.includes(knownCode) ||
      (knownCode === 'NO_NUMBER_SLOT_AVAILABLE' && (rawMessage.includes('INSUFFICIENT_NUMBER_SLOTS') || rawMessage.includes('capacity exceeded') || rawMessage.includes('max_active_numbers_exceeded'))) ||
      (knownCode === 'OVER_ENTITLED' && (rawMessage.includes('OVER_ENTITLED') || rawMessage.includes('over_entitled'))) ||
      (knownCode === 'COMPLIANCE_REQUIRED' && (rawMessage.includes('REGULATORY_COMPLIANCE_REQUIRED') || rawMessage.includes('compliance_required'))) ||
      (knownCode === 'CAPABILITY_NOT_USABLE' && (rawMessage.includes('CAPABILITY_DISABLED') || rawMessage.includes('VOICE_CAPABILITY_DISABLED'))) ||
      (knownCode === 'ACTIVE_TRAFFIC_BLOCKS_RELEASE' && (rawMessage.includes('ACTIVE_TRAFFIC') || rawMessage.includes('ACTIVE_CALL'))) ||
      (knownCode === 'INVENTORY_VANISHED' && rawMessage.includes('INVENTORY_VANISHED')) ||
      (knownCode === 'PORT_OUT_LOCKED' && rawMessage.includes('PORT_OUT_LOCKED')) ||
      (knownCode === 'PROTECTED_PILOT_QUARANTINE' && rawMessage.includes('PROTECTED_PILOT')) ||
      (knownCode === 'PROVIDER_OUTCOME_UNKNOWN' && rawMessage.includes('UNKNOWN'))
    ) {
      matchedCode = knownCode as CanonicalErrorCode;
      break;
    }
  }

  if (matchedCode && ERROR_TAXONOMY[matchedCode]) {
    const spec = ERROR_TAXONOMY[matchedCode];
    return {
      success: false,
      errorCode: matchedCode,
      message: options.customMessage || spec.message,
      httpStatus: options.httpStatus || spec.status,
      isRetryable: spec.isRetryable,
      recommendedAction: spec.recommendedAction,
      reconciliationRequired: options.reconciliationRequired ?? spec.reconciliationRequired,
      operationId: opId,
    };
  }

  // Generic fallback: sanitize any sensitive patterns
  const isAuth = rawMessage.includes('UNAUTHORIZED') || rawMessage.includes('FORBIDDEN') || rawMessage.includes('ROLE');
  return {
    success: false,
    errorCode: (options.customCode as any) || (isAuth ? 'ROLE_NOT_AUTHORIZED' : 'INTERNAL_ERROR'),
    message: isAuth ? 'You do not have permission to execute this telecom operation.' : fallbackMessage,
    httpStatus: options.httpStatus || (isAuth ? 403 : 500),
    isRetryable: false,
    recommendedAction: isAuth ? 'Contact your organization administrator.' : 'Please try again later or contact support.',
    operationId: opId,
  };
}

/**
 * Helper to build Next.js NextResponse directly from an error.
 */
export function canonicalErrorResponse(
  errorOrCode: any,
  fallbackOrOptions?: string | CanonicalErrorOptions
): NextResponse {
  const safe = sanitizeCanonicalError(errorOrCode, fallbackOrOptions);
  return NextResponse.json(safe, { status: safe.httpStatus });
}
