import { NextResponse } from 'next/server';
import {
  authenticateExtensionRequest,
  getExtensionCorsHeaders,
  handleExtensionCorsOptions,
} from '@/lib/telephony/extensionAuth';
import { executeOutboundCallSetup, OutboundCallError } from '@/lib/telephony/outboundCallService';

export async function OPTIONS(request: Request) {
  return handleExtensionCorsOptions(request);
}

export async function POST(request: Request) {
  const corsHeaders = getExtensionCorsHeaders(request);

  try {
    const { auth, errorResponse } = await authenticateExtensionRequest(request);
    if (errorResponse) return errorResponse;
    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401, headers: corsHeaders });
    }

    const body = await request.json().catch(() => ({}));
    const destination = body.destination || body.to || '';
    const fromNumber = body.fromNumber || body.from || '';
    const recordCall = Boolean(body.recordCall);

    // Call shared server-only outbound call service
    const result = await executeOutboundCallSetup({
      userId: auth.userId,
      organizationId: auth.organizationId,
      destination,
      fromNumber,
      recordCall,
    });

    return NextResponse.json(result, { headers: corsHeaders });
  } catch (error: any) {
    if (error instanceof OutboundCallError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode, headers: corsHeaders });
    }

    console.error('Error in POST /api/extension/calls/create:', error.message || error);
    return NextResponse.json(
      { error: 'Internal server error creating call record.' },
      { status: 500, headers: corsHeaders }
    );
  }
}
