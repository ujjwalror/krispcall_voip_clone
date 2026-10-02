import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyHmacRequest } from '@/lib/billing/reconciliation/hmacSecurityUtils';
import { FinancialReconciliationRunnerService } from '@/lib/billing/reconciliation/financialReconciliationRunnerService';
import { ReconciliationRunType, TargetEntityType } from '@/lib/billing/reconciliation/reconciliationTypes';

export async function POST(req: NextRequest) {
  // 1. Production Enable Gate Check
  if (process.env.RECONCILIATION_ENABLED !== 'true') {
    return NextResponse.json(
      { error: 'RECONCILIATION_DISABLED_BY_EXECUTION_GATE', message: 'Reconciliation is currently disabled in this environment.' },
      { status: 403 }
    );
  }

  // 2. Read Raw Request Body & Security Signature Header
  const rawBody = await req.text();
  const signatureHeader = req.headers.get('x-reconciliation-signature');

  // Initialize service-role Supabase client
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    console.error('[InternalReconciliationApi] Missing Supabase service-role credentials.');
    return NextResponse.json({ error: 'SERVER_CONFIGURATION_ERROR' }, { status: 500 });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 3. HMAC-SHA256 Signature, Timestamp Drift, & Replay Protection Verification
  const authResult = await verifyHmacRequest({
    supabase,
    signatureHeader,
    rawBody,
  });

  if (!authResult.valid) {
    console.warn('[InternalReconciliationApi] Unauthorized HMAC request rejected:', authResult.reason);
    return NextResponse.json({ error: 'UNAUTHORIZED', reason: authResult.reason }, { status: 401 });
  }

  // 4. Parse & Validate Payload JSON
  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch (err) {
    return NextResponse.json({ error: 'INVALID_JSON_PAYLOAD' }, { status: 400 });
  }

  const { runType, organizationId, targetedEntityType, targetedEntityId } = body || {};

  // 5. Allowlist & Bounded Scope Validation for Serverless HTTP Route
  const allowedHttpScopes: ReconciliationRunType[] = ['targeted'];
  if (!runType || !allowedHttpScopes.includes(runType as ReconciliationRunType)) {
    return NextResponse.json(
      {
        error: 'UNSUPPORTED_HTTP_SCOPE',
        message: 'HTTP internal route supports targeted scope only. Organization, provider account, and full system sweeps require CLI/Worker daemon.',
      },
      { status: 400 }
    );
  }

  // UUID Format validation
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (runType === 'organization') {
    if (!organizationId || !uuidRegex.test(organizationId)) {
      return NextResponse.json({ error: 'INVALID_ORGANIZATION_UUID' }, { status: 400 });
    }
  }

  const allowedTargetTypes: TargetEntityType[] = [
    'payment_operation',
    'refund_request',
    'payment_refund',
    'payment_dispute',
    'financial_hold',
    'account_debt',
    'wallet_ledger',
    'provider_account',
    'telecom_reservation',
  ];

  if (runType === 'targeted') {
    if (!targetedEntityType || !allowedTargetTypes.includes(targetedEntityType)) {
      return NextResponse.json({ error: 'INVALID_TARGETED_ENTITY_TYPE' }, { status: 400 });
    }
    if (!targetedEntityId || typeof targetedEntityId !== 'string' || !targetedEntityId.trim()) {
      return NextResponse.json({ error: 'INVALID_TARGETED_ENTITY_ID' }, { status: 400 });
    }
  }

  // 6. Execute Durable Runner Service
  const runner = new FinancialReconciliationRunnerService();
  const result = await runner.run(supabase, {
    runType,
    organizationId,
    targetedEntityType,
    targetedEntityId,
    workerId: 'http_internal_trigger',
    environment: (process.env.NEXT_PUBLIC_STRIPE_ENVIRONMENT as 'test' | 'live') || 'test',
  });

  return NextResponse.json(
    {
      success: true,
      runId: result.runId,
      status: result.status,
      summaryCounts: result.summaryCounts,
      moduleCoverage: result.moduleCoverage,
    },
    { status: result.status === 'skipped' ? 200 : 200 }
  );
}
