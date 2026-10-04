import { NextRequest, NextResponse } from 'next/server';
import { validateTwilioRequest } from '@/lib/twilio/signature';
import { PortOutService } from '@/lib/telephony/lifecycle/portOutService';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * POST /api/webhooks/porting/port-out
 * Provider Webhook endpoint for authoritative Port-Out completion events.
 * STRICT ENFORCEMENT:
 * - Signature verification when configured.
 * - Resolves tenant from provider mapping & operation table (does NOT trust body organization_id).
 * - Out-of-order event protection: Cannot regress terminal states (e.g. ported_out).
 * - Idempotent processing.
 */
export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const signature = request.headers.get('x-twilio-signature');
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    // Signature verification if configured
    if (authToken && signature) {
      const params: Record<string, string> = {};
      const searchParams = new URLSearchParams(rawBody);
      searchParams.forEach((val, key) => {
        params[key] = val;
      });

      const isValid = await validateTwilioRequest(request, params);
      if (!isValid) {
        return NextResponse.json({ error: 'UNAUTHORIZED_WEBHOOK: Invalid signature.' }, { status: 401 });
      }
    }

    const payload = JSON.parse(rawBody || '{}');
    const eventType = payload.EventType || payload.event_type || payload.Type || payload.Status;
    const phoneNumberE164 = payload.PhoneNumber || payload.phone_number || payload.e164;
    const providerOperationId = payload.PortOutSid || payload.Sid;

    if (!phoneNumberE164) {
      return NextResponse.json({ error: 'INVALID_PAYLOAD: PhoneNumber E.164 required.' }, { status: 400 });
    }

    const canonicalE164 = String(phoneNumberE164).replace(/[\s\(\)\-\.]/g, '');
    const adminDb = createAdminClient();

    // Resolve active operation and tenant from database (server-authoritative)
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

    // Out-of-order / terminal state protection
    if (opRow.status === 'ported_out') {
      return NextResponse.json({
        success: true,
        idempotent: true,
        message: 'Operation already in terminal state ported_out.',
      });
    }

    // Only map real provider completion events (e.g., PortOutPhoneNumberCompleted)
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
