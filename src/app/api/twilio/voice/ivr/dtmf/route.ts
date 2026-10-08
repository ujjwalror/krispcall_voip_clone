import { NextResponse } from 'next/server';
import twilio from 'twilio';
import { validateTwilioRequest } from '@/lib/twilio/signature';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * POST /api/twilio/voice/ivr/dtmf
 * DTMF Keypress Webhook & Timeout/Fallback Callback Endpoint.
 * Validates Twilio signature, parses selected Digits, executes server-authoritative
 * IVR destination routing, handles retry/timeout bounds, and prevents loops.
 */
export async function POST(request: Request) {
  try {
    const postParams: Record<string, string> = {};

    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      formData.forEach((value, key) => {
        if (typeof value === 'string') {
          postParams[key] = value;
        }
      });
    } else if (contentType.includes('application/json')) {
      const json = await request.json().catch(() => ({}));
      Object.assign(postParams, json);
    }

    // 1. Validate signature using POST body parameters
    const isValidSignature = await validateTwilioRequest(request, postParams);
    if (!isValidSignature) {
      console.error('[TWILIO IVR DTMF WEBHOOK ERROR] Unauthorized signature failure.');
      const errRes = new twilio.twiml.VoiceResponse();
      errRes.say('Unauthorized webhook request.');
      errRes.reject();
      return new NextResponse(errRes.toString(), {
        status: 403,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    const params: Record<string, string> = { ...postParams };
    const { searchParams } = new URL(request.url);
    searchParams.forEach((val, key) => {
      if (!params[key]) params[key] = val;
    });

    const callSid = params.CallSid || params.callSid || '';
    const digits = (params.Digits || params.digits || '').trim();
    const menuId = (params.menuId || searchParams.get('menuId') || '').trim();
    const dbCallId = (params.callId || searchParams.get('callId') || '').trim();
    const depth = parseInt(params.depth || searchParams.get('depth') || '1', 10);
    const currentRetry = parseInt(params.retry || searchParams.get('retry') || '0', 10);

    console.log('[TWILIO IVR DTMF REQUEST]', {
      callSid,
      digits,
      menuId,
      depth,
      currentRetry,
    });

    const adminSupabase = createAdminClient();
    const twiml = new twilio.twiml.VoiceResponse();

    // 2. Fetch IVR Menu & Options
    if (!menuId) {
      twiml.say('An error occurred during menu routing. Connecting to main operator.');
      twiml.hangup();
      return new NextResponse(twiml.toString(), { status: 200, headers: { 'Content-Type': 'text/xml' } });
    }

    const { data: menu } = await (adminSupabase as any)
      .from('ivr_menus')
      .select('*, ivr_options(*)')
      .eq('id', menuId)
      .maybeSingle();

    if (!menu || menu.enabled === false) {
      twiml.say('The requested menu is currently unavailable.');
      twiml.hangup();
      return new NextResponse(twiml.toString(), { status: 200, headers: { 'Content-Type': 'text/xml' } });
    }

    const organizationId = menu.organization_id;

    // 3. Enforce server-side IVR entitlement check
    const { hasEntitlement } = await import('@/lib/entitlements/server');
    const ivrEntitled = await hasEntitlement('ivr', adminSupabase);
    if (!ivrEntitled) {
      twiml.say('Interactive Voice Response feature is currently disabled.');
      twiml.hangup();
      return new NextResponse(twiml.toString(), { status: 200, headers: { 'Content-Type': 'text/xml' } });
    }

    // 4. Handle Valid DTMF Digit Input
    if (digits) {
      const options: any[] = Array.isArray(menu.ivr_options) ? menu.ivr_options : [];
      const selectedOption = options.find((o) => o.digit === digits && o.enabled !== false);

      if (selectedOption) {
        console.log(`[TWILIO IVR DTMF MATCH] Digit '${digits}' selected. Routing to type '${selectedOption.destination_type}'.`);

        const destType = selectedOption.destination_type;
        const destId = selectedOption.destination_id;

        if (destType === 'user' && destId) {
          // Route to User Extension Client
          const { data: targetProfile } = await (adminSupabase as any)
            .from('profiles')
            .select('id, full_name')
            .eq('id', destId)
            .eq('organization_id', organizationId)
            .maybeSingle();

          if (targetProfile) {
            const dial = twiml.dial({ timeout: 25 });
            dial.client(destId);
            return new NextResponse(twiml.toString(), { status: 200, headers: { 'Content-Type': 'text/xml' } });
          }
        } else if (destType === 'ivr' && destId) {
          // Nested IVR Menu Routing (with loop and max depth check)
          if (destId === menuId || depth >= 3) {
            console.warn(`[TWILIO IVR LOOP GUARD] Max depth (${depth}) or direct cycle reached. Falling back.`);
            twiml.say('Max menu depth reached. Connecting to fallback operator.');
            twiml.hangup();
            return new NextResponse(twiml.toString(), { status: 200, headers: { 'Content-Type': 'text/xml' } });
          }

          const { data: targetMenu } = await (adminSupabase as any)
            .from('ivr_menus')
            .select('*')
            .eq('id', destId)
            .eq('organization_id', organizationId)
            .maybeSingle();

          if (targetMenu && targetMenu.enabled !== false) {
            const nextDepth = depth + 1;
            const gather = twiml.gather({
              action: `/api/twilio/voice/ivr/dtmf?menuId=${targetMenu.id}&callId=${dbCallId}&depth=${nextDepth}&retry=0`,
              numDigits: 1,
              timeout: targetMenu.timeout_seconds || 5,
              method: 'POST',
            });
            gather.say(targetMenu.greeting_text || 'Please make a selection.');
            return new NextResponse(twiml.toString(), { status: 200, headers: { 'Content-Type': 'text/xml' } });
          }
        } else if (destType === 'call_queue') {
          twiml.say('Call Queues are under development. Connecting to main extension.');
          twiml.hangup();
          return new NextResponse(twiml.toString(), { status: 200, headers: { 'Content-Type': 'text/xml' } });
        } else if (destType === 'hangup') {
          twiml.say('Thank you for calling. Goodbye.');
          twiml.hangup();
          return new NextResponse(twiml.toString(), { status: 200, headers: { 'Content-Type': 'text/xml' } });
        }
      }
    }

    // 5. Handle Invalid Input or Timeout (Retry Bounded Loop)
    const nextRetry = currentRetry + 1;
    if (nextRetry < (menu.max_retries || 3)) {
      console.log(`[TWILIO IVR RETRY] Retry ${nextRetry}/${menu.max_retries || 3} for menu ${menuId}`);
      const gather = twiml.gather({
        action: `/api/twilio/voice/ivr/dtmf?menuId=${menuId}&callId=${dbCallId}&depth=${depth}&retry=${nextRetry}`,
        numDigits: 1,
        timeout: menu.timeout_seconds || 5,
        method: 'POST',
      });
      gather.say(`Invalid selection. ${menu.greeting_text || 'Please try again.'}`);
      return new NextResponse(twiml.toString(), { status: 200, headers: { 'Content-Type': 'text/xml' } });
    }

    // 6. Max Retries Reached -> Trigger Fallback Destination
    console.log(`[TWILIO IVR FALLBACK] Max retries (${menu.max_retries || 3}) reached for menu ${menuId}. Executing fallback.`);
    const fallbackType = menu.fallback_destination_type || 'user';
    const fallbackId = menu.fallback_destination_id;

    if (fallbackType === 'user' && fallbackId) {
      const dial = twiml.dial({ timeout: 25 });
      dial.client(fallbackId);
      return new NextResponse(twiml.toString(), { status: 200, headers: { 'Content-Type': 'text/xml' } });
    }

    twiml.say('Thank you for calling. Goodbye.');
    twiml.hangup();
    return new NextResponse(twiml.toString(), { status: 200, headers: { 'Content-Type': 'text/xml' } });
  } catch (err: any) {
    console.error('[POST /api/twilio/voice/ivr/dtmf] Exception:', err.message || err);
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say('An internal error occurred. Goodbye.');
    twiml.hangup();
    return new NextResponse(twiml.toString(), { status: 500, headers: { 'Content-Type': 'text/xml' } });
  }
}
