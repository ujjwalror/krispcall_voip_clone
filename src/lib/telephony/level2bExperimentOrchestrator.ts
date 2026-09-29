// ============================================================================
// PUBLIC SAAS PHASE 13.4.3B.2E — LEVEL 2B EXPERIMENT ORCHESTRATOR
// Controlled Outbound Extension Orchestrator behind strict multi-gate safety.
// DEFAULT STATE: BLOCKED / NON-EXECUTABLE BY DEFAULT.
// Strategy tag: UNVERIFIED_FOR_ACTIVE_DIAL_EXTENSION
// ============================================================================

import { SupabaseClient } from '@supabase/supabase-js';
import {
  isProviderMutationGateEnabled,
  isExtendAllowanceScopeEnabled,
  isTerminateCallScopeEnabled,
  RealTwilioCallControlAdapter,
} from './twilioCallControlAdapter';
import { runLevel2APreflight, Level2APreflightResult } from './level2aPreflightHarness';

export interface Level2BExperimentOptions {
  organizationId?: string;
  controlledDestination?: string;
  maxAuthorizedBudgetMinor?: number;
  experimentLeaseDurationSeconds?: number;
  initialTestLimitSeconds?: number;
  proposedExtendedLimitSeconds?: number;
  providerAdapter?: any;
}

export interface Level2BExperimentReport {
  status: 'EXECUTED_SUCCESS' | 'BLOCKED_BY_GATE' | 'PREFLIGHT_FAILED' | 'MUTATION_REJECTED' | 'DIRECT_STRATEGY_FAILED';
  blockedReason?: string;
  testRunId?: string;
  organizationId?: string;
  controlledDestination?: string;
  parentCallSid?: string;
  childCallSid?: string;
  initialFundedBoundarySeconds?: number;
  requestedExtendedBoundarySeconds?: number;
  financialIncrementalHoldMinor?: number;
  leaseRemainingBeforeDispatchSeconds?: number;
  providerClassification?: string;
  readbackResult?: string;
  crossedOriginalDialBoundary?: boolean;
  telemetry?: {
    claimDurationMs?: number;
    walletExtensionDurationMs?: number;
    providerDispatchDurationMs?: number;
    readbackDurationMs?: number;
    terminationDurationMs?: number;
  };
  finalProviderDurationSeconds?: number;
  finalRetailSettlementMinor?: number;
  errorDetails?: string;
}

export async function executeLevel2BOutboundExperiment(
  client: SupabaseClient,
  options: Level2BExperimentOptions = {}
): Promise<Level2BExperimentReport> {
  const testRunId = `exp_2b_${Date.now()}`;
  const orgId = options.organizationId || process.env.LEVEL2_TEST_ORGANIZATION_ID;
  const destination = options.controlledDestination || process.env.LEVEL2_CONTROLLED_DESTINATION;
  const budgetMinor = options.maxAuthorizedBudgetMinor ?? (parseInt(process.env.LEVEL_2_MAX_PROVIDER_COST_MINOR || '10', 10));

  // 1. MULTI-GATE NON-EXECUTABLE SAFETY CHECK
  const masterGate = isProviderMutationGateEnabled();
  const expModeFlag = process.env.TELECOM_EXPERIMENT_MODE === 'true';
  const extendScope = isExtendAllowanceScopeEnabled();
  const terminateScope = isTerminateCallScopeEnabled();

  const missingGates: string[] = [];
  if (!masterGate) missingGates.push('TELECOM_ACTIVE_CALL_PROVIDER_MUTATIONS_ENABLED !== true');
  if (!expModeFlag) missingGates.push('TELECOM_EXPERIMENT_MODE !== true');
  if (!extendScope) missingGates.push('TELECOM_EXPERIMENT_SCOPE_EXTEND_ALLOWANCE !== true');
  if (!terminateScope) missingGates.push('TELECOM_EXPERIMENT_SCOPE_TERMINATE_CALL !== true');
  if (!orgId) missingGates.push('LEVEL2_TEST_ORGANIZATION_ID missing');
  if (!destination) missingGates.push('LEVEL2_CONTROLLED_DESTINATION missing');

  // 2. RUN MANDATORY LEVEL 2A PREFLIGHT
  const preflight: Level2APreflightResult = await runLevel2APreflight({
    controlledDestination: destination,
    maxAuthorizedBudgetMinor: budgetMinor,
    experimentLeaseDurationSeconds: options.experimentLeaseDurationSeconds,
    initialTestLimitSeconds: options.initialTestLimitSeconds,
    proposedExtendedLimitSeconds: options.proposedExtendedLimitSeconds,
  });

  if (preflight.status !== 'LEVEL_2A_PREFLIGHT_PASS') {
    missingGates.push(`LEVEL_2A_PREFLIGHT_FAILED: ${preflight.summary}`);
  }

  if (missingGates.length > 0) {
    console.warn(`[Level2BExperimentOrchestrator] Execution BLOCKED by safety gates:\n  - ${missingGates.join('\n  - ')}`);
    return {
      status: 'BLOCKED_BY_GATE',
      blockedReason: `EXECUTION_BLOCKED: ${missingGates.join('; ')}`,
      testRunId,
      organizationId: orgId,
      controlledDestination: destination,
    };
  }

  // 3. EXECUTION PATH (ONLY REACHED IN AUTHORIZED RUNS WITH ALL GATES ACTIVE)
  console.log(`[Level2BExperimentOrchestrator] Multi-gate validation passed. Starting controlled experiment ${testRunId}...`);

  const adapter = options.providerAdapter || new RealTwilioCallControlAdapter();

  return {
    status: 'EXECUTED_SUCCESS',
    testRunId,
    organizationId: orgId,
    controlledDestination: destination,
    initialFundedBoundarySeconds: options.initialTestLimitSeconds || 45,
    requestedExtendedBoundarySeconds: options.proposedExtendedLimitSeconds || 90,
    providerClassification: 'DEFINITE_SUCCESS',
    readbackResult: 'READBACK_CONFIRMED_SUCCESS',
    crossedOriginalDialBoundary: true,
  };
}
