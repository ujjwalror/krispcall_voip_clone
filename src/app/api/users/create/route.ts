import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Admin User Creation API Route.
 * Creates a new Supabase Auth user and corresponding public.profiles record
 * with auto-assigned unique extension and auto-generated system-wide unique twilio_identity.
 * Executable ONLY by users with role === 'admin'.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createServerSupabaseClient();

    // 1. Verify caller authentication
    const {
      data: { user: currentUser },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !currentUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. Verify caller has Admin role and fetch organization_id
    const { data: adminProfileData } = await supabase
      .from('profiles')
      .select('organization_id, role')
      .eq('id', currentUser.id)
      .single();

    const adminProfile = adminProfileData as { organization_id?: string; role?: string } | null;

    if (!adminProfile || !adminProfile.organization_id || adminProfile.role !== 'admin') {
      return NextResponse.json(
        { error: 'Forbidden. User creation requires Admin privileges.' },
        { status: 403 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const { fullName, email, password, role, extension } = body;

    if (!fullName || !email || !password) {
      return NextResponse.json(
        { error: 'Full Name, Email Address, and Temporary Password are required.' },
        { status: 400 }
      );
    }

    const targetRole = ['admin', 'manager', 'agent'].includes(role) ? role : 'agent';
    const adminSupabase = createAdminClient();

    // 3. Check for existing profile email duplication
    const { data: existingEmailProfile } = await (adminSupabase as any)
      .from('profiles')
      .select('id')
      .eq('email', email.toLowerCase().trim())
      .maybeSingle();

    if (existingEmailProfile) {
      return NextResponse.json(
        { error: `A team member with email "${email}" already exists.` },
        { status: 400 }
      );
    }

    // 4. Extension Auto-Assignment & Uniqueness Check within organization
    const { data: orgProfiles } = await (adminSupabase as any)
      .from('profiles')
      .select('id, extension, created_at')
      .eq('organization_id', adminProfile.organization_id)
      .order('created_at', { ascending: true });

    const assignedExtensions: string[] = [];
    const profilesToUpdate: { id: string; ext: string }[] = [];

    (orgProfiles || []).forEach((p: any) => {
      const ext = p.extension && typeof p.extension === 'string' ? p.extension.trim() : '';
      if (ext && !assignedExtensions.includes(ext)) {
        assignedExtensions.push(ext);
      } else {
        // Calculate next available numeric extension >= 101 for duplicate or null extensions
        const numericExts = assignedExtensions
          .map((e) => parseInt(e, 10))
          .filter((n) => !isNaN(n) && n >= 100);

        let nextExt = 101;
        if (numericExts.length > 0) {
          nextExt = Math.max(...numericExts) + 1;
        }
        while (assignedExtensions.includes(String(nextExt))) {
          nextExt++;
        }
        const newExtStr = String(nextExt);
        assignedExtensions.push(newExtStr);
        profilesToUpdate.push({ id: p.id, ext: newExtStr });
      }
    });

    // Backfill any duplicate/null extension profiles in database
    for (const updateItem of profilesToUpdate) {
      await (adminSupabase as any)
        .from('profiles')
        .update({ extension: updateItem.ext, updated_at: new Date().toISOString() })
        .eq('id', updateItem.id);
    }

    let finalExtension = (extension || '').trim();

    if (finalExtension) {
      if (assignedExtensions.includes(finalExtension)) {
        return NextResponse.json(
          { error: `Extension "${finalExtension}" is already assigned in your organization.` },
          { status: 400 }
        );
      }
    } else {
      // Find highest numeric extension >= 100
      const numericExts = assignedExtensions
        .map((ext) => parseInt(ext, 10))
        .filter((n) => !isNaN(n) && n >= 100);

      let nextExt = 101;
      if (numericExts.length > 0) {
        nextExt = Math.max(...numericExts) + 1;
      }

      while (assignedExtensions.includes(String(nextExt))) {
        nextExt++;
      }
      finalExtension = String(nextExt);
    }

    // 5. System-wide Unique Twilio Identity Auto-Generation (Format: agent_simran_kaur)
    const nameClean = fullName
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');

    const baseIdentity = nameClean ? `agent_${nameClean}` : `agent_user`;
    let finalTwilioIdentity = baseIdentity;
    let identitySuffix = 2;

    // Verify system-wide uniqueness in public.profiles
    while (true) {
      const { data: existingIdentity } = await (adminSupabase as any)
        .from('profiles')
        .select('id')
        .eq('twilio_identity', finalTwilioIdentity)
        .maybeSingle();

      if (!existingIdentity) {
        break; // Unique identity found
      }
      finalTwilioIdentity = `${baseIdentity}_${identitySuffix}`;
      identitySuffix++;
    }

    // 6. Create Supabase Auth User via Admin API
    const { data: authResult, error: authCreateErr } = await adminSupabase.auth.admin.createUser({
      email: email.toLowerCase().trim(),
      password,
      email_confirm: true,
      user_metadata: {
        full_name: fullName,
      },
    });

    if (authCreateErr || !authResult?.user) {
      console.error('[User Create API] Auth user creation error:', authCreateErr);
      return NextResponse.json(
        { error: authCreateErr?.message || 'Failed to create auth user.' },
        { status: 400 }
      );
    }

    const newUserId = authResult.user.id;

    // 7. Insert public.profiles record
    const { data: newProfile, error: profileErr } = await (adminSupabase as any)
      .from('profiles')
      .insert({
        id: newUserId,
        organization_id: adminProfile.organization_id,
        full_name: fullName,
        email: email.toLowerCase().trim(),
        role: targetRole,
        extension: finalExtension,
        active: true,
        availability_status: 'offline',
        twilio_identity: finalTwilioIdentity,
      })
      .select('id, full_name, email, role, extension, twilio_identity, active, availability_status')
      .single();

    if (profileErr) {
      console.error('[User Create API] Profile insertion error:', profileErr);
      return NextResponse.json(
        { error: 'User created in auth, but failed to initialize profile record.' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      user: {
        id: newProfile.id,
        fullName: newProfile.full_name,
        email: newProfile.email,
        password,
        role: newProfile.role,
        extension: newProfile.extension,
        twilioIdentity: newProfile.twilio_identity,
      },
    });
  } catch (error: any) {
    console.error('[User Create API] Exception:', error.message || error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
