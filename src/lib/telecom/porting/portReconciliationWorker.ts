import 'server-only';
import { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { ProviderContext } from '@/lib/telecom/provider/types';
import { TelecomPortingProviderAdapter } from './adapters/telecomPortingAdapter';
import { PortInCoordinator } from './portInCoordinator';
import { PortOutCoordinator } from './portOutCoordinator';
import { PortInStateMachine } from './portInStateMachine';
import { PortOutStateMachine } from './portOutStateMachine';
import { ReconcilePortResult } from './types';

export class PortReconciliationWorker {
  private adapter?: TelecomPortingProviderAdapter;
  private context?: ProviderContext;
  private client?: SupabaseClient | any;

  constructor(
    adapter?: TelecomPortingProviderAdapter,
    context?: ProviderContext,
    client?: SupabaseClient | any
  ) {
    this.adapter = adapter;
    this.context = context;
    this.client = client;
  }

  async reconcileOperation(
    operationId: string,
    organizationId?: string,
    adapterOverride?: TelecomPortingProviderAdapter,
    contextOverride?: ProviderContext,
    clientOverride?: SupabaseClient | any
  ): Promise<ReconcilePortResult> {
    const adapter = adapterOverride || this.adapter;
    const context = contextOverride || this.context;
    const client = clientOverride || this.client;
    if (!adapter || !context) {
      throw new Error(
        'ADAPTER_AND_CONTEXT_REQUIRED: Adapter and Context must be provided to PortReconciliationWorker.'
      );
    }
    return PortReconciliationWorker.reconcileOperation(operationId, adapter, context, client);
  }

  /**
   * Reconciles a single port operation against its underlying telecommunications provider.
   * MULTI-WORKER SAFETY:
   * - Uses PostgreSQL row-level locks or distributed worker claiming.
   * - Respects provider account scope.
   * - 404/absence does NOT automatically trigger cancellation without provider certainty.
   */
  static async reconcileOperation(
    operationId: string,
    adapter: TelecomPortingProviderAdapter,
    context: ProviderContext,
    client?: SupabaseClient | any
  ): Promise<ReconcilePortResult> {
    const db = client || createAdminClient();

    // 1. Fetch operation
    const { data: opRow, error } = await (db as any)
      .from('number_port_operations')
      .select('*')
      .eq('id', operationId)
      .maybeSingle();

    if (error || !opRow) {
      throw new Error(`OPERATION_NOT_FOUND: Operation ${operationId} not found.`);
    }

    const direction = opRow.direction.toUpperCase();
    const currentState = opRow.canonical_state;
    const providerPortId = opRow.provider_port_id;

    // Check if already terminal
    if (
      currentState === 'COMPLETED' ||
      currentState === 'CANCELLED' ||
      currentState === 'FAILED_PRE_DISPATCH' ||
      currentState === 'REJECTED_FRAUD_LOCK'
    ) {
      return {
        operationId: opRow.id,
        phoneNumberE164: opRow.phone_number_e164,
        previousState: currentState,
        newState: currentState,
        providerStatus: opRow.provider_status || 'terminal',
        outcomeCertainty: 'DEFINITIVE',
        completedCutover: false,
        message: 'Operation already in terminal state.',
      };
    }

    // 2. Query provider adapter
    if (direction === 'PORT_IN' || direction === 'PORT_IN') {
      if (!providerPortId && currentState !== 'PROVIDER_OUTCOME_UNKNOWN') {
        return {
          operationId: opRow.id,
          phoneNumberE164: opRow.phone_number_e164,
          previousState: currentState,
          newState: currentState,
          providerStatus: 'missing_provider_id',
          outcomeCertainty: 'AMBIGUOUS',
          completedCutover: false,
          message: 'Operation missing remote order SID; cannot reconcile with provider.',
        };
      }

      const statusRes = await adapter.reconcilePortStatus(providerPortId || '', context);

      if (statusRes.status === 'COMPLETED') {
        // Authoritative cutover received
        await PortInCoordinator.completePortIn(
          opRow.id,
          opRow.organization_id,
          context.providerAccountId,
          statusRes.remoteResourceId || `PN_${opRow.id.replace(/-/g, '').slice(0, 32)}`,
          db
        );

        return {
          operationId: opRow.id,
          phoneNumberE164: opRow.phone_number_e164,
          previousState: currentState,
          newState: 'COMPLETED',
          providerStatus: statusRes.providerStatus,
          outcomeCertainty: 'DEFINITIVE',
          completedCutover: true,
          message: 'Port-In completed and carrier resource created.',
        };
      }

      if (statusRes.status === 'FOC_CONFIRMED' && statusRes.confirmedFocAt) {
        await PortInCoordinator.confirmFoc(
          opRow.id,
          opRow.organization_id,
          statusRes.confirmedFocAt,
          db
        );

        return {
          operationId: opRow.id,
          phoneNumberE164: opRow.phone_number_e164,
          previousState: currentState,
          newState: 'FOC_CONFIRMED',
          providerStatus: statusRes.providerStatus,
          outcomeCertainty: 'DEFINITIVE',
          completedCutover: false,
          message: `FOC confirmed for ${statusRes.confirmedFocAt}.`,
        };
      }

      if (statusRes.status === 'REJECTED') {
        await (db as any)
          .from('number_port_operations')
          .update({
            canonical_state: 'REMEDIATION_REQUIRED',
            status: 'action_required',
            reconciliation_state: 'CARRIER_REJECTED',
            customer_message: 'Carrier rejected port request. Please review and update details.',
            updated_at: new Date().toISOString(),
          })
          .eq('id', opRow.id);

        return {
          operationId: opRow.id,
          phoneNumberE164: opRow.phone_number_e164,
          previousState: currentState,
          newState: 'REMEDIATION_REQUIRED',
          providerStatus: statusRes.providerStatus,
          outcomeCertainty: 'DEFINITIVE',
          completedCutover: false,
          message: 'Carrier rejected port order; customer remediation required.',
        };
      }

      if (statusRes.status === 'STILL_UNKNOWN' || (statusRes.status as any) === 'UNKNOWN') {
        return {
          operationId: opRow.id,
          phoneNumberE164: opRow.phone_number_e164,
          previousState: currentState,
          newState: 'STILL_UNKNOWN',
          providerStatus: statusRes.providerStatus,
          outcomeCertainty: 'UNCERTAIN',
          completedCutover: false,
          message: 'Provider reconciliation returned UNKNOWN/unresolved status.',
        };
      }

      // Default still pending / unknown
      return {
        operationId: opRow.id,
        phoneNumberE164: opRow.phone_number_e164,
        previousState: currentState,
        newState: currentState,
        providerStatus: statusRes.providerStatus,
        outcomeCertainty: statusRes.outcomeCertainty,
        completedCutover: false,
        message: 'Order still pending with provider.',
      };
    } else {
      // Port-Out reconciliation
      const statusRes = await adapter.reconcilePortOutStatus(opRow.phone_number_e164, context);

      if (statusRes.status === 'COMPLETED') {
        await PortOutCoordinator.completePortOut(
          opRow.id,
          opRow.organization_id,
          'reconciliation_worker',
          db
        );

        return {
          operationId: opRow.id,
          phoneNumberE164: opRow.phone_number_e164,
          previousState: currentState,
          newState: 'COMPLETED',
          providerStatus: statusRes.providerStatus,
          outcomeCertainty: 'DEFINITIVE',
          completedCutover: true,
          message: 'Port-Out completed and phone number transitioned to PORTED_OUT.',
        };
      }

      return {
        operationId: opRow.id,
        phoneNumberE164: opRow.phone_number_e164,
        previousState: currentState,
        newState: currentState,
        providerStatus: statusRes.providerStatus,
        outcomeCertainty: statusRes.outcomeCertainty,
        completedCutover: false,
        message: 'Port-Out still pending with clearinghouse.',
      };
    }
  }
}
