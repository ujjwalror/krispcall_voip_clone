import { NextResponse } from 'next/server';
import twilio from 'twilio';
import { normalizeE164PhoneNumber } from '@/lib/utils';
import { validateTwilioRequest } from '@/lib/twilio/signature';

/**
 * Outbound Voice TwiML Webhook Endpoint for Twilio Programmable Voice.
 * Configured in Twilio Console as the Voice Request URL for the TwiML App.
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

    // Verify webhook signature (if TWILIO_AUTH_TOKEN is configured)
    const isValidSignature = await validateTwilioRequest(request, params);
    if (!isValidSignature) {
      const errorResponse = new twilio.twiml.VoiceResponse();
      errorResponse.say('Unauthorized Twilio webhook request.');
      errorResponse.reject();
      return new NextResponse(errorResponse.toString(), {
        status: 403,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    // Extract destination number passed from browser device.connect({ params: { To: ... } })
    const rawDestination = params.To || params.to || params.PhoneNumber || '';
    const validation = normalizeE164PhoneNumber(rawDestination);

    const voiceResponse = new twilio.twiml.VoiceResponse();

    if (!validation.isValid || !validation.normalized) {
      voiceResponse.say('Invalid or unconfigured destination phone number specified.');
      voiceResponse.reject();
      return new NextResponse(voiceResponse.toString(), {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    // Dial destination using approved server-side TWILIO_PHONE_NUMBER caller ID
    const callerId = process.env.TWILIO_PHONE_NUMBER || '+18005550199';
    const dial = voiceResponse.dial({ callerId });
    dial.number(validation.normalized);

    return new NextResponse(voiceResponse.toString(), {
      status: 200,
      headers: {
        'Content-Type': 'text/xml',
      },
    });
  } catch (error: any) {
    console.error('Error generating outbound TwiML:', error.message || error);
    const errorResponse = new twilio.twiml.VoiceResponse();
    errorResponse.say('An error occurred while processing the outbound call.');
    errorResponse.reject();
    return new NextResponse(errorResponse.toString(), {
      status: 500,
      headers: { 'Content-Type': 'text/xml' },
    });
  }
}

export async function GET(request: Request) {
  return POST(request);
}
