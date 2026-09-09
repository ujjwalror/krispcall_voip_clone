import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { checkTwilioConfigHealth } from '@/lib/twilio/config';

export async function GET() {
  try {
    const supabase = await createServerSupabaseClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized. Authenticated session required.' },
        { status: 401 }
      );
    }

    const health = checkTwilioConfigHealth();

    return NextResponse.json({
      status: health.configured ? 'ready' : 'pending_configuration',
      health,
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: 'Failed to evaluate Twilio server health status.' },
      { status: 500 }
    );
  }
}
