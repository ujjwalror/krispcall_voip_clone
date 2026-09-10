import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';

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

    const { data: profileData, error: profileError } = await supabase
      .from('profiles')
      .select('organization_id, role')
      .eq('id', user.id)
      .single();

    const profile = profileData as { organization_id?: string; role?: string } | null;

    if (profileError || !profile || !profile.organization_id) {
      return NextResponse.json(
        { error: 'Forbidden. User organization not found.' },
        { status: 403 }
      );
    }

    const { data: orgData, error: orgError } = await supabase
      .from('organizations')
      .select('auto_recording_enabled')
      .eq('id', profile.organization_id)
      .single();

    const org = orgData as { auto_recording_enabled?: boolean } | null;

    return NextResponse.json({
      autoRecordingEnabled: org?.auto_recording_enabled ?? true,
      role: profile.role || 'agent',
    });
  } catch (error: any) {
    console.error('Error fetching recording settings:', error.message || error);
    return NextResponse.json(
      { error: 'Failed to fetch workspace recording preferences.' },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
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

    const { data: profileData, error: profileError } = await supabase
      .from('profiles')
      .select('organization_id, role')
      .eq('id', user.id)
      .single();

    const profile = profileData as { organization_id?: string; role?: string } | null;

    if (profileError || !profile || !profile.organization_id) {
      return NextResponse.json(
        { error: 'Forbidden. User organization not found.' },
        { status: 403 }
      );
    }

    // Admin role check for modifying workspace settings
    if (profile.role !== 'admin') {
      return NextResponse.json(
        { error: 'Forbidden. Only organization Admins can change auto recording settings.' },
        { status: 403 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const autoRecordingEnabled = Boolean(body.autoRecordingEnabled);

    const { error: updateError } = await (supabase as any)
      .from('organizations')
      .update({ auto_recording_enabled: autoRecordingEnabled, updated_at: new Date().toISOString() })
      .eq('id', profile.organization_id);

    if (updateError) {
      console.error('Error updating organization auto recording setting:', updateError);
      return NextResponse.json(
        { error: 'Failed to update workspace recording preference.' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      autoRecordingEnabled,
    });
  } catch (error: any) {
    console.error('Error updating recording settings:', error.message || error);
    return NextResponse.json(
      { error: 'Failed to update workspace recording preference.' },
      { status: 500 }
    );
  }
}
