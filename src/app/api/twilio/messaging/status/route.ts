import { NextResponse } from 'next/server';
import twilio from 'twilio';
import { validateTwilioRequest } from '@/lib/twilio/signature';
import { createAdminClient } from '@/lib/supabase/admin';
import { normalizeTwilioMessageStatus, shouldUpdateMessageStatus } from '@/lib/telephony/smsService';

/**
 * Delivery Status Callback Webhook Endpoint for Twilio Messaging.
 * Receives async updates (queued, sending, sent, delivered, undelivered, failed).
 */
export async function POST(request: Request) {
  try {
    const params: Record<string, string> = {};

    // Parse incoming request parameters (Twilio sends application/x-www-form-urlencoded)
    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      formData.forEach((value, key) => {
        if (typeof value === 'string') {
          params[key] = value;
        }
      });
    } else if (contentType.includes('application/json')) {
      const json = await request.json().catch(() => ({}));
      Object.assign(params, json);
    }

    // Fallback query parameters
    const { searchParams } = new URL(request.url);
    searchParams.forEach((val, key) => {
      if (!params[key]) params[key] = val;
    });

    // 1. Verify Twilio Webhook Signature
    const isValidSignature = await validateTwilioRequest(request, params);
    if (!isValidSignature) {
      console.warn('[Twilio SMS Status Webhook] Rejected request with invalid HTTP signature.');
      return NextResponse.json({ error: 'Unauthorized signature.' }, { status: 403 });
    }

    // 2. Extract Status Callback Parameters
    const messageSid = params.MessageSid || params.SmsSid || '';
    const rawStatus = params.MessageStatus || params.SmsStatus || '';
    const errorCode = params.ErrorCode || params.errorCode || null;
    const errorMessage = params.ErrorMessage || params.errorMessage || null;

    if (!messageSid || !rawStatus) {
      return NextResponse.json({ success: true, message: 'No MessageSid or status provided.' }, { status: 200 });
    }

    const normalizedStatus = normalizeTwilioMessageStatus(rawStatus);
    const adminSupabase = createAdminClient();

    // 3. Locate database message record by twilio_message_sid
    const { data: existingMsg, error: fetchErr } = await (adminSupabase as any)
      .from('messages')
      .select('id, status, organization_id')
      .eq('twilio_message_sid', messageSid)
      .maybeSingle();

    if (fetchErr || !existingMsg) {
      console.warn(`[Twilio SMS Status Webhook] MessageSid "${messageSid}" not found in database. Ignoring update.`);
      return NextResponse.json({ success: true, message: 'Message SID unmapped.' }, { status: 200 });
    }

    // 4. Status Transition Precedence Guard: Avoid overwriting terminal state with delayed out-of-order transient state
    const currentStatus = existingMsg.status || 'queued';
    if (!shouldUpdateMessageStatus(currentStatus, normalizedStatus)) {
      console.log(`[Twilio SMS Status Webhook] Transition skipped for MessageSid "${messageSid}". Current: "${currentStatus}", Incoming: "${normalizedStatus}".`);
      return NextResponse.json({ success: true, message: 'Status transition skipped due to precedence rules.' }, { status: 200 });
    }

    // 5. Update database record with new status & optional provider error codes
    const updatePayload: Record<string, any> = {
      status: normalizedStatus,
      updated_at: new Date().toISOString(),
    };

    if (errorCode) {
      updatePayload.error_code = String(errorCode);
    }
    if (errorMessage) {
      updatePayload.error_message = String(errorMessage);
    }

    const { error: updateErr } = await (adminSupabase as any)
      .from('messages')
      .update(updatePayload)
      .eq('id', existingMsg.id);

    if (updateErr) {
      console.error(`[Twilio SMS Status Webhook] Update error for message "${existingMsg.id}":`, updateErr);
      return NextResponse.json({ error: 'Database update failed.' }, { status: 500 });
    }

    console.log(`[Twilio SMS Status Webhook] Updated message "${existingMsg.id}" (SID: ${messageSid}) status to "${normalizedStatus}".`);
    return NextResponse.json({ success: true, status: normalizedStatus });
  } catch (error: any) {
    console.error('Error in POST /api/twilio/messaging/status:', error.message || error);
    return NextResponse.json({ error: 'Internal server error processing status webhook.' }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return POST(request);
}
