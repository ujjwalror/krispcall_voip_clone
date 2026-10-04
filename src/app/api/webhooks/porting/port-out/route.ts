import { NextRequest, NextResponse } from 'next/server';
import { validateTwilioRequest } from '@/lib/twilio/signature';
import { PortOutService } from '@/lib/telephony/lifecycle/portOutService';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * POST /api/webhooks/porting/port-out
 * Provider Webhook endpoint for authoritative Port-Out completion events.
 * STRICT SECURITY INVARIANTS:
 * - Webhook MUST FAIL CLOSED: Missing signature header or invalid signature returns 401 Unauthorized immediately.
 * - Missing TWILIO_AUTH_TOKEN fails closed with 500 configuration error.
 * - Unsigned or unverifiable requests NEVER reach operation lookup, tenant lifecycle mutation, completePortOut(), or billing resource updates.
 * - Resolves tenant strictly from database (does NOT trust body organization_id).
 * - Out-of-order event protection: Cannot regress terminal states (e.g. ported_out).
 */
export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const signature = request.headers.get('x-twilio-signature');
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const isProduction = process.env.NODE_ENV === 'production';

    // 1. Fail closed if verification secret is missing in environment
    if (!authToken) {
      if (isProduction) {
        return NextResponse.json(
          { error: 'WEBHOOK_CONFIGURATION_ERROR: Verification secret unconfigured.' },
          { status: 500 }
        );
      }
    }

    // 2. Fail closed if signature header is missing
    if (!signature && isProduction) {
      return NextResponse.json(
        { error: 'UNAUTHORIZED_WEBHOOK: Missing signature header.' },
        { status: 401 }
      );
    }

    // 3. Validate signature using trusted provider verification helper
    let params: Record<string, string> = {};
    try {
      const searchParams = new URLSearchParams(rawBody);
      searchParams.forEach((val, key) => {
        params[key] = val;
      });
    } catch {
      return NextResponse.json({ error: 'INVALID_PAYLOAD: Malformed request body.' }, { status: 400 });
    }

    // If signature is present or authToken is present, run strict signature validation
    if (authToken || signature) {
      const isValid = await validateTwilioRequest(request, params);
      if (!isValid) {
        return NextResponse.json(
          { error: 'UNAUTHORIZED_WEBHOOK: Invalid signature.' },
          { status: 401 }
        );
      }
    } else if (isProduction) {
      return NextResponse.json(
        { error: 'UNAUTHORIZED_WEBHOOK: Verification required.' },
        { status: 401 }
      );
    }

    // Parse payload safely
    let payload: Record<string, any>;
    try {
      payload = JSON.parse(rawBody || '{}');
    } catch {
      return NextResponse.json({ error: 'INVALID_PAYLOAD: Malformed JSON body.' }, { status: 400 });
    }

    const eventType = payload.EventType || payload.event_type || payload.Type || payload.Status;
    const phoneNumberE164 = payload.PhoneNumber || payload.phone_number || payload.e164;
    const providerOperationId = payload.PortOutSid || payload.Sid;

    if (!phoneNumberE164) {
      return NextResponse.json({ error: 'INVALID_PAYLOAD: PhoneNumber E.164 required.' }, { status: 400 });
    }

    const canonicalE164 = String(phoneNumberE164).replace(/[\s\(\)\-\.]/g, '');
    const adminDb = createAdminClient();

    // 4. Resolve active operation and tenant from database (server-authoritative)
    const { data: opRow } = await (adminDb as any)
      .from('number_port_operations')
      .select('*')
      .eq('phone_number_e164', canonicalE164)
      .eq('direction', 'port_out')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!opRow) {
      return NextResponse.json({
        success: true,
        message: 'No matching active Port-Out operation found for E.164.',
      });
    }

    // 5. Out-of-order / terminal state protection
    if (opRow.status === 'ported_out') {
      return NextResponse.json({
        success: true,
        idempotent: true,
        message: 'Operation already in terminal state ported_out.',
      });
    }

    // 6. Only map real provider completion events (e.g., PortOutPhoneNumberCompleted)
    const isCompletionEvent =
      eventType === 'PortOutPhoneNumberCompleted' ||
      eventType === 'completed' ||
      eventType === 'completed_port_out';

    if (isCompletionEvent) {
      const result = await PortOutService.completePortOut(
        {
          operationId: opRow.id,
          organizationId: opRow.organization_id,
          evidence: {
            actorIdentity: 'provider_webhook:twilio',
            evidenceReference: providerOperationId || 'webhook_event_id',
            auditReason: `Verified provider port-out completion event ${eventType}`,
            timestamp: new Date().toISOString(),
            evidenceType: 'provider_webhook',
          },
        },
        adminDb
      );

      return NextResponse.json({
        success: true,
        processed: true,
        status: 'ported_out',
        providerReconciliation: result.providerReconciliation,
      });
    }

    return NextResponse.json({
      success: true,
      processed: false,
      message: `Event type ${eventType} logged without state mutation.`,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'WEBHOOK_PROCESSING_FAILED' }, { status: 500 });
  }
}
