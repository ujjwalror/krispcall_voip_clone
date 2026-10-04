import 'server-only';

export type ProviderWorkflowMode =
  | 'automated_api'
  | 'assisted_manual'
  | 'unsupported'
  | 'requires_recheck'
  | 'unknown';

export type PortInDomainState =
  | 'draft'
  | 'portability_checking'
  | 'requirements_pending'
  | 'ready_for_submission'
  | 'submitted'
  | 'under_review'
  | 'action_required'
  | 'waiting_for_signature'
  | 'in_progress'
  | 'scheduled'
  | 'completed'
  | 'canceled'
  | 'failed'
  | 'manual_review_required';

export type PortOutDomainState =
  | 'requested'
  | 'instructions_ready'
  | 'port_out_pending'
  | 'carrier_processing'
  | 'action_required'
  | 'ported_out'
  | 'canceled'
  | 'manual_review_required';

export type ReleaseDomainState =
  | 'release_requested'
  | 'release_pending'
  | 'reconciliation_required'
  | 'released'
  | 'manual_review_required';

export interface PortabilityCheckResult {
  portable: boolean | null;
  workflowMode: ProviderWorkflowMode;
  countryCode: string;
  numberType: 'local' | 'mobile' | 'toll_free' | 'unknown';
  accountNumberRequired: boolean;
  pinRequired: boolean;
  providerReasonCodeInternal?: string | null;
  customerReason: string;
  checkedAt: string;
  expiresAt: string;
}

export interface PortOutInstructionDTO {
  phoneNumberE164: string;
  status: PortOutDomainState;
  instructionSummary: string;
  accountNumberRequired: boolean;
  pinRequired: boolean;
  customerServiceAddressRequired: boolean;
  notes?: string[];
}

export interface CustomerPortOperationDTO {
  operationId: string;
  phoneNumberE164: string;
  direction: 'port_in' | 'port_out';
  status: string;
  workflowMode: ProviderWorkflowMode;
  customerMessage: string;
  retailAmountFormatted?: string | null;
  scheduledTransferAt?: string | null;
  completedAt?: string | null;
  createdAt: string;
}

export interface AutomaticReleaseEvaluationParams {
  organizationId: string;
  phoneNumberId: string;
  phoneNumberE164: string;
  numberStatus: string;
  billableResourceStatus?: string | null;
  paymentState?: 'paid' | 'past_due' | 'unpaid' | 'unknown';
  activePortOutPending: boolean;
  providerAmbiguityOrReconciliationRequired: boolean;
  legalOrRegulatoryHold: boolean;
  concurrentDestructiveOperation: boolean;
  ownershipMismatch: boolean;
}

export interface AutomaticReleaseEvaluationResult {
  eligible: boolean;
  reason: string;
  blockers: string[];
}
