import { NextRequest, NextResponse } from 'next/server';
import { requireActiveSession } from '@/lib/auth/requireActiveSession';
import { createAdminClient } from '@/lib/supabase/admin';
import { CommercialCaptureReconciliationService } from '@/lib/billing/commercialCaptureReconciliationService';
import { CommercialSagaStateMachine, CommercialSagaState } from '@/lib/billing/commercialSagaStateMachine';

/**
 * POST /api/billing/checkout/fulfill
 * Commercial Checkout Fulfillment Endpoint.
 * 
 * GATE ORDERING:
 * 1. Authenticate session via requireActiveSession()
 * 2. Authorize Owner/Admin role privileges & active organization profile
 * 3. Validate request parameters
 * 4. FEATURE GATE EVALUATION: PHASE13_PAYMENT_ENABLED === 'true'
 *    - If FALSE: Returns HTTP 200/202 with customer DTO BEFORE any DB claim RPC or capture POST.
 * 5. Invoke Authoritative Shared Reconciliation
 */
export async function POST(req: NextRequest) {
  try {
    // 1. Session Authentication
    const sessionResult = await requireActiveSession();
    if (!sessionResult.success) {
      return sessionResult.errorResponse;
    }

    const { user, supabase } = sessionResult;

    // 2. Server-Authoritative Role & Organization Authorization
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('organization_id, role, active')
      .eq('id', user.id)
      .maybeSingle();

    if (profileError || !profile || !profile.organization_id || profile.active === false) {
      return NextResponse.json(
        { error: 'FORBIDDEN: Active organization profile required.' },
        { status: 403 }
      );
    }

    const userRole = (profile.role || '').toLowerCase();
    if (userRole !== 'owner' && userRole !== 'admin') {
      return NextResponse.json(
        { error: 'FORBIDDEN: Commercial fulfillment requires Owner or Admin role privileges.' },
        { status: 403 }
      );
    }

    // 3. Request Parameter Validation & Trust Boundary Enforcement
    const body = await req.json().catch(() => ({}));
    const { sagaId, providerPaymentId } = body;

    if (!sagaId || typeof sagaId !== 'string') {
      return NextResponse.json(
        { error: 'BAD_REQUEST: sagaId is required.' },
        { status: 400 }
      );
    }

    const adminSupabase = createAdminClient();

    // Server-authoritative saga loading & tenant security boundary
    const { data: saga, error: sagaError } = await (adminSupabase as any)
      .from('commercial_number_purchase_sagas')
      .select('*')
      .eq('id', sagaId)
      .maybeSingle();

    if (sagaError || !saga) {
      return NextResponse.json(
        { error: 'NOT_FOUND: Commercial saga not found.' },
        { status: 404 }
      );
    }

    if (saga.organization_id !== profile.organization_id) {
      return NextResponse.json(
        { error: 'FORBIDDEN: Commercial saga does not belong to user organization.' },
        { status: 403 }
      );
    }

    // SERVER-AUTHORITATIVE PAYMENT LINKAGE VERIFICATION
    // Browser MUST NOT dictate provider_payment_id. Validate client assertion against canonical record if supplied.
    if (providerPaymentId && typeof providerPaymentId === 'string') {
      if (saga.payment_operation_id) {
        const { data: paymentOp } = await (adminSupabase as any)
          .from('billing_payment_operations')
          .select('provider_payment_id')
          .eq('id', saga.payment_operation_id)
          .maybeSingle();

        if (paymentOp && paymentOp.provider_payment_id && paymentOp.provider_payment_id !== providerPaymentId) {
          return NextResponse.json(
            { error: 'BAD_REQUEST: Client-supplied providerPaymentId does not match canonical payment operation.' },
            { status: 400 }
          );
        }
      }
    }

    // 4. CRITICAL FEATURE GATE CHECK
    const isPaymentEnabled = process.env.PHASE13_PAYMENT_ENABLED === 'true';
    if (!isPaymentEnabled) {
      // Gate is disabled: Return customer-safe processing DTO BEFORE consuming durable claims or calling capture
      const currentState = (saga?.state || 'ownership_confirmed') as CommercialSagaState;
      return NextResponse.json({
        success: true,
        gateEnabled: false,
        customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO(currentState),
        message: 'Payment authorization hold verified. Line activation in progress.',
      }, { status: 200 });
    }

    // 5. Authoritative Shared Reconciliation Pathway (when gate enabled)
    const stripeMode = (process.env.STRIPE_EXPECTED_MODE || 'test') as 'test' | 'live';
    const result = await CommercialCaptureReconciliationService.reconcilePaymentStateAndCompleteSaga(
      adminSupabase,
      {
        sagaId,
        providerPaymentId,
        expectedMode: stripeMode,
      }
    );

    return NextResponse.json({
      success: result.success,
      customerDTO: result.customerDTO,
      classification: result.classification,
      message: result.message,
    });
  } catch (error: any) {
    console.error('[POST /api/billing/checkout/fulfill] Exception in fulfillment route:', error.message || error);
    return NextResponse.json(
      {
        success: false,
        customerDTO: CommercialSagaStateMachine.mapStateToCustomerDTO('failed'),
        error: 'An unexpected error occurred processing fulfillment.',
      },
      { status: 500 }
    );
  }
}
