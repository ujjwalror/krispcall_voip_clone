import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';

/**
 * POST /api/contacts/[contactId]/block
 * Toggles is_blocked status for a contact in the user's organization.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ contactId: string }> }
) {
  try {
    const { contactId } = await params;
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

    const { data: profile, error: profileError } = await (supabase as any)
      .from('profiles')
      .select('organization_id')
      .eq('id', user.id)
      .single();

    if (profileError || !profile || !profile.organization_id) {
      return NextResponse.json(
        { error: 'Forbidden. User organization unconfigured.' },
        { status: 403 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const isBlocked = Boolean(body.isBlocked);

    const { data: updatedContact, error: updateError } = await (supabase as any)
      .from('contacts')
      .update({
        is_blocked: isBlocked,
        updated_at: new Date().toISOString(),
      })
      .eq('id', contactId)
      .eq('organization_id', profile.organization_id)
      .select()
      .single();

    if (updateError || !updatedContact) {
      console.error('Error updating contact block status:', updateError);
      return NextResponse.json(
        { error: 'Failed to update contact block status.' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      contact: updatedContact,
      message: isBlocked ? 'Contact blocked successfully.' : 'Contact unblocked successfully.',
    });
  } catch (error: any) {
    console.error('Error in POST /api/contacts/[contactId]/block:', error.message || error);
    return NextResponse.json(
      { error: 'Internal server error updating contact block status.' },
      { status: 500 }
    );
  }
}
