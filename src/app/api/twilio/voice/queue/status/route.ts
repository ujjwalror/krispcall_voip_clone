import { NextResponse } from 'next/server';
import { QueueService } from '@/lib/telephony/queueService';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * POST /api/twilio/voice/queue/status
 * Twilio Call Status Callback handler for Call Queue calls.
 * Reconciles provider call state (ringing, in-progress, completed, busy, no-answer, canceled, failed) with queue entry state.
 */
export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const callSid = formData.get('CallSid')?.toString();
    const callStatus = formData.get('CallStatus')?.toString();
    const parentCallSid = formData.get('ParentCallSid')?.toString();

    const targetSid = parentCallSid || callSid;

    if (!targetSid) {
      return new NextResponse('<Response/>', { headers: { 'Content-Type': 'text/xml' } });
    }

    const adminSupabase = createAdminClient();

    let finalStatus: 'completed' | 'abandoned' | 'failed' | 'no-answer' = 'completed';
    if (callStatus === 'no-answer' || callStatus === 'busy') {
      finalStatus = 'no-answer';
    } else if (callStatus === 'canceled') {
      finalStatus = 'abandoned';
    } else if (callStatus === 'failed') {
      finalStatus = 'failed';
    }

    await QueueService.handleCallDisconnect(targetSid, finalStatus, adminSupabase);

    return new NextResponse('<Response/>', { headers: { 'Content-Type': 'text/xml' } });
  } catch (error: any) {
    console.error('[Queue Status Callback] Error:', error.message || error);
    return new NextResponse('<Response/>', { headers: { 'Content-Type': 'text/xml' } });
  }
}
