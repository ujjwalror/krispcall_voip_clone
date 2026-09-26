import 'server-only';
import { NextResponse } from 'next/server';
import { validateTwilioRequest } from '@/lib/twilio/signature';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Webhook handler for Twilio Regulatory Compliance Bundle status updates.
 * Validates request signature, maps bundle SID to tenant compliance profile,
 * updates mapping provider_status, and processes status callbacks idempotently.
 */
export async function POST(request: Request) {
  try {
    const rawText = await request.text();
    const searchParams = new URLSearchParams(rawText);
    const bodyParams: Record<string, string> = {};
    searchParams.forEach((val, key) => {
      bodyParams[key] = val;
    });

    // 1. Signature Validation
    const isValid = await validateTwilioRequest(request, bodyParams);
    if (!isValid) {
      console.warn('[Twilio Compliance Callback] Invalid signature. Rejecting request.');
      return new NextResponse('Invalid signature', { status: 403 });
    }

    // 2. Extract Webhook Parameters
    const bundleSid = bodyParams.CustomerProfileSid || bodyParams.BundleSid || bodyParams.Sid;
    const providerStatus = bodyParams.Status || bodyParams.CustomerProfileStatus || bodyParams.BundleStatus;
    const rejectReason = bodyParams.RejectReason || bodyParams.FailureReason || null;

    if (!bundleSid || !providerStatus) {
      return new NextResponse('Missing required parameters (BundleSid, Status)', { status: 400 });
    }

    console.log(`[Twilio Compliance Callback] Status update received for Bundle ${bundleSid}: ${providerStatus}`);

    const supabase = createAdminClient() as any;

    // 3. Lookup Resource Mapping for Bundle
    const { data: mapping, error: mapErr } = await supabase
      .from('provider_resource_mappings')
      .select('*')
      .eq('provider', 'twilio')
      .eq('resource_type', 'bundle')
      .eq('provider_resource_id', bundleSid)
      .maybeSingle();

    if (mapErr || !mapping) {
      console.warn(`[Twilio Compliance Callback] No provider mapping found for bundle SID: ${bundleSid}`);
      return new NextResponse('Mapping not found', { status: 200 }); // Return 200 to acknowledge Twilio
    }

    // 4. Status Normalization & Idempotent Update
    const currentStatus = mapping.provider_status;
    const normalizedStatus = providerStatus.toLowerCase();

    if (currentStatus !== normalizedStatus) {
      const updatedMetadata = {
        ...mapping.metadata,
        lastCallbackReceivedAt: new Date().toISOString(),
        lastCallbackStatus: providerStatus,
        rejectReason: rejectReason,
      };

      await supabase
        .from('provider_resource_mappings')
        .update({
          provider_status: normalizedStatus,
          metadata: updatedMetadata,
        })
        .eq('id', mapping.id);

      console.log(`[Twilio Compliance Callback] Successfully updated bundle ${bundleSid} status from '${currentStatus}' to '${normalizedStatus}'.`);
    } else {
      console.log(`[Twilio Compliance Callback] Duplicate status '${normalizedStatus}' received for bundle ${bundleSid}. Handled idempotently.`);
    }

    return new NextResponse(
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
      {
        status: 200,
        headers: { 'Content-Type': 'application/xml' },
      }
    );
  } catch (err: any) {
    console.error('[Twilio Compliance Callback] Error handling webhook:', err);
    return new NextResponse('Internal server error', { status: 500 });
  }
}
