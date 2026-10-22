/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';

export type BackfillEvidenceClassification =
  | 'DETERMINISTIC_FROM_LOCAL_DATA'
  | 'REQUIRES_PROVIDER_RECONCILIATION'
  | 'REQUIRES_OPERATOR_REVIEW'
  | 'PROTECTED_RESOURCE_DO_NOT_TOUCH'
  | 'CANNOT_SAFELY_INFER';

export type BackfillPlannedAction =
  | 'INSERT_CANONICAL'
  | 'UPDATE_CANONICAL'
  | 'NO_OP'
  | 'MANUAL_REVIEW'
  | 'PROVIDER_RECONCILE'
  | 'QUARANTINE_NO_OP';

export type BackfillPlanStatus =
  | 'PLANNED'
  | 'CLAIMED'
  | 'APPLIED'
  | 'FAILED'
  | 'CONFLICT'
  | 'STALE_SOURCE'
  | 'SKIPPED';

export interface BackfillPlanItem {
  id?: string;
  organizationId: string;
  phoneNumberId?: string | null;
  phoneNumberE164: string;
  sourceEvidence: Record<string, any>;
  targetCanonicalState: {
    ownership_state?: string;
    service_state?: string;
    capabilities_state?: Record<string, any>;
    assignment_target_type?: string;
    assignment_target_id?: string | null;
    provider_account_id?: string | null;
    provider_resource_record_id?: string | null;
    remote_resource_id?: string | null;
    compliance_state?: string;
    porting_state?: string;
    port_out_locked?: boolean;
  };
  classification: BackfillEvidenceClassification;
  confidenceScore: number;
  evidenceReason: string;
  plannedAction: BackfillPlannedAction;
  status: BackfillPlanStatus;
  claimToken?: string | null;
  sourceVersionHash: string;
  errorReason?: string | null;
}

export interface BackfillDryRunSummary {
  totalDiscovered: number;
  plannedInserts: number;
  plannedUpdates: number;
  noOps: number;
  manualReviewRequired: number;
  providerReconcileRequired: number;
  protectedResources: number;
  conflicts: number;
  items: BackfillPlanItem[];
}

export interface ShadowComparisonDivergence {
  phoneNumberId: string;
  phoneNumberE164: string;
  organizationId: string;
  dimension: 'LIFECYCLE' | 'ASSIGNMENT' | 'CAPABILITY' | 'PORTING' | 'COMPLIANCE';
  legacyValue: unknown;
  canonicalValue: unknown;
  severity: 'CRITICAL' | 'WARNING' | 'INFO';
  description: string;
}

export interface ShadowComparisonReport {
  totalInspected: number;
  exactMatches: number;
  divergencesFound: number;
  divergences: ShadowComparisonDivergence[];
}

export interface ProductionPrecheckReport {
  isReadyForDryRun: boolean;
  schemaPrerequisitesMet: boolean;
  missingPrerequisites: string[];
  canonicalTablesPresent: string[];
  canonicalRpcsPresent: string[];
  canonicalTriggersPresent: string[];
  legacySourceRecordCounts: {
    phoneNumbers: number;
    lifecycleStates: number;
    providerMappings: number;
    userAssignments: number;
  };
  protectedPilotFound: boolean;
  activeConflictsDetected: number;
  manualReviewEstimate: number;
}
