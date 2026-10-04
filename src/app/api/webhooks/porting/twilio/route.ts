import { NextRequest, NextResponse } from 'next/server';
import { validateTwilioRequest } from '@/lib/twilio/signature';
import { PortInService } from '@/lib/telephony/lifecycle/portInService';
import { createAdminClient } from '@/lib/supabase/admin';

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const signature = request.headers.get('x-twilio-signature');

    const authToken = process.env.TWILIO_AUTH_TOKEN;

    // Validate Twilio Signature if configured
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
    const providerPortId = payload.PortInSid || payload.port_in_sid || payload.Sid;
    const phoneNumberE164 = payload.PhoneNumber || payload.phone_number;
    const providerEventStatus = payload.Status || payload.status || payload.PortInStatus;

    if (!providerEventStatus) {
      return NextResponse.json({ error: 'INVALID_WEBHOOK_PAYLOAD: Status missing.' }, { status: 400 });
    }

    const adminDb = createAdminClient();
    const result = await PortInService.handleWebhookEvent(
      {
        providerPortId,
        phoneNumberE164,
        providerEventStatus,
        rawPayload: payload,
      },
      adminDb
    );

    return NextResponse.json({
      success: true,
      processed: result.processed,
      newStatus: result.newStatus,
      reason: result.reason,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'WEBHOOK_PROCESSING_FAILED' }, { status: 500 });
  }
}
